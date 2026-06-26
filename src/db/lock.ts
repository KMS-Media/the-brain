import { openSync, closeSync, writeSync, rmSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Cross-process advisory lock for a single graph store, re-entrant per process.
 *
 * Kuzu is an embedded single-writer database: multiple processes opening the
 * same file concurrently collide (lock errors, WAL races). Every accessor — the
 * long-lived MCP server, the prompt hooks, and the CLI — serializes through this
 * cooperative `.brain.lock` file, so only one process touches Kuzu at a time and
 * hands off cleanly.
 *
 * Within a SINGLE process Kuzu does allow several handles on the same store
 * (e.g. cross-project search opens many), so the lock is reference-counted in
 * memory: the on-disk lockfile is taken when the first handle opens a store and
 * removed when the last one closes. A stale lockfile (holder crashed) is broken
 * early via a PID reachability check (process.kill pid,0) with an mtime-based
 * fallback after `BRAIN_LOCK_STALE_MS` (default 15s).
 */

const STALE_MS = Math.max(
  1_000,
  Number(process.env.BRAIN_LOCK_STALE_MS) || 15_000,
);

export interface LockHandle {
  release(): void;
}

interface Held {
  count: number;
  releaseFile: () => void;
}

/** Per-process reference counts so same-process re-entry doesn't self-deadlock. */
const held = new Map<string, Held>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read the PID from lockfile, or null if missing/invalid. */
function readPidFromLock(lockPath: string): number | null {
  try {
    const content = readFileSync(lockPath, "utf8").trim();
    if (!content) return null;
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Check if a process with the given PID is still alive (POSIX signal 0). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code !== "ESRCH";
  }
}

/** Take the on-disk lockfile (cross-process), waiting/breaking-stale as needed. */
async function takeFileLock(storageDir: string, timeoutMs: number): Promise<() => void> {
  const lockPath = join(storageDir, ".brain.lock");
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx"); // atomic: fails if it already exists
      writeSync(fd, `${process.pid}`);
      closeSync(fd);
      let released = false;
      const remove = () => {
        if (released) return;
        released = true;
        try {
          rmSync(lockPath, { force: true });
        } catch {
          /* already gone */
        }
      };
      const onExit = () => remove();
      process.once("exit", onExit);
      return () => {
        process.removeListener("exit", onExit);
        remove();
      };
    } catch {
      // PID check: if the holder process is dead, break the lock immediately.
      try {
        const pid = readPidFromLock(lockPath);
        if (pid !== null && !isPidAlive(pid)) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        /* fall through to mtime check */
      }
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // lockfile vanished between attempts — retry immediately
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for the the_brain database lock (${lockPath}).`);
      }
      await sleep(40 + Math.floor(Math.random() * 60));
    }
  }
}

export async function acquireLock(storageDir: string, timeoutMs?: number): Promise<LockHandle> {
  timeoutMs ??= Math.max(100, Number(process.env.BRAIN_LOCK_TIMEOUT) || 10_000);
  const key = resolve(storageDir);
  const existing = held.get(key);
  if (existing) {
    existing.count++;
    return makeHandle(key);
  }
  const releaseFile = await takeFileLock(storageDir, timeoutMs);
  held.set(key, { count: 1, releaseFile });
  return makeHandle(key);
}

function makeHandle(key: string): LockHandle {
  let released = false;
  return {
    release() {
      if (released) return; // a handle releases at most once
      released = true;
      const entry = held.get(key);
      if (!entry) return;
      entry.count--;
      if (entry.count <= 0) {
        entry.releaseFile();
        held.delete(key);
      }
    },
  };
}
