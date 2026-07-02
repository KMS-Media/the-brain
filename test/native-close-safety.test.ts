import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression tests for the MCP-server crash fixed in PR #18: a native Kuzu
 * close within ~0–100 ms of a
 * real ONNX embedding call segfaults the whole process (SIGSEGV). Two paths
 * used to hit it:
 *
 * 1. One-shot processes (CLI command, Stop hook): open Memory, do a
 *    knowledge-bearing write, call close() in the same continuation. Fixed by
 *    GraphDB.close() skipping the native teardown entirely (a process about
 *    to exit doesn't need it).
 * 2. The long-lived MCP server: MemoryGate's idle release calls the full
 *    native teardown, and BRAIN_MCP_IDLE_MS is tunable down to ~0 ms —
 *    idleMs=1 reproduced the crash 5/5 pre-fix. Fixed by
 *    Memory.disposeSafely(), which waits out the race window relative to the
 *    last real embed before closing natively.
 *
 * Direct testing disproved the issue's original hypothesis (a `tags STRING[]`
 * parameter-binding crash): identical writes with and without `tags` crashed
 * at the same near-100% rate, and binding a STRING[] parameter alone (no
 * embedding involved) never crashed. The one-shot child below includes `tags`
 * so both the segfault regression and the STRING[] binding stay covered.
 *
 * These tests MUST use the real embedder (BRAIN_FAKE_EMBED=0) — the crash
 * never occurs with the fake hashing embedder used elsewhere in the suite.
 * The model is warmed once in this parent process (no child-side download
 * against the 30s spawn budget); if the model is unavailable (BRAIN_OFFLINE=1
 * with a cold cache) the tests skip instead of failing. Each child runs once
 * and retries once on failure: the pre-fix crashes were near-deterministic,
 * so a single run detects a regression, and the retry tolerates the rare
 * pre-existing ONNX/Kuzu exit-time flake documented in test/run.mjs.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let realEmbedderUnavailable: string | null = null;

before(async () => {
  const prev = process.env.BRAIN_FAKE_EMBED;
  process.env.BRAIN_FAKE_EMBED = "0";
  try {
    const { embed } = await import("../src/embeddings/embedder.js");
    await embed("warm the embedding model cache for the child processes");
  } catch (e) {
    realEmbedderUnavailable = String((e as Error).message ?? e);
  } finally {
    if (prev === undefined) delete process.env.BRAIN_FAKE_EMBED;
    else process.env.BRAIN_FAKE_EMBED = prev;
  }
});

function oneShotChildScript(storeDir: string): string {
  return `
    import { Memory } from ${JSON.stringify(join(ROOT, "src/core.ts"))};
    const memory = await Memory.openAt(${JSON.stringify(storeDir)});
    await memory.repo.upsertNode("Knowledge", {
      title: "one-shot close() regression",
      content: "content long enough to need a real embedding computation",
      tags: ["EA-7983", "docker", "migration"],
    });
    // Mirrors src/bin/brain.ts and src/hooks/learn.ts: close() called
    // synchronously right after the embedding-triggering write resolves.
    memory.close();
  `;
}

function gateChildScript(storeDir: string): string {
  return `
    import { Memory } from ${JSON.stringify(join(ROOT, "src/core.ts"))};
    import { MemoryGate } from ${JSON.stringify(join(ROOT, "src/mcp/server.ts"))};
    // idleMs=1: the release fires ~1ms after the embedding write completes —
    // deep inside the native-close race window. Pre-fix this segfaulted 5/5;
    // disposeSafely's embed-distance delay is what keeps it alive.
    const gate = new MemoryGate(() => Memory.openAt(${JSON.stringify(storeDir)}), 1);
    await gate.run((m) => m.repo.upsertNode("Knowledge", {
      title: "gate idle-release regression",
      content: "content long enough to need a real embedding computation",
    }));
    // Keep the process alive long enough for the idle release (plus the
    // safety delay) to run to completion.
    await new Promise((r) => setTimeout(r, 1500));
  `;
}

function runChild(tmpRoot: string, script: string) {
  // The script lives OUTSIDE the store dir so a crash leaves it behind for
  // forensics (the store dir is a Kuzu database, wiped wholesale on cleanup).
  const scriptPath = join(tmpRoot, "child.mjs");
  writeFileSync(scriptPath, script);
  return spawnSync("node", ["--import", "tsx", scriptPath], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env, BRAIN_FAKE_EMBED: "0" },
    timeout: 30_000,
  });
}

function describeExit(r: ReturnType<typeof runChild>): string {
  return r.status !== null ? `status ${r.status}` : `signal ${r.signal}`;
}

/** One run detects the (near-deterministic) regression; one retry tolerates the rare exit-time flake. */
function assertCleanExitWithRetry(tmpRoot: string, script: string): void {
  const first = runChild(tmpRoot, script);
  if (first.status === 0) return;
  const second = runChild(tmpRoot, script);
  assert.equal(
    second.status,
    0,
    `both child runs crashed (${describeExit(first)}, ${describeExit(second)}); stderr of second run:\n${second.stderr}`,
  );
}

test("one-shot process: close() right after an embedding write does not crash", { timeout: 90_000 }, (t) => {
  if (realEmbedderUnavailable) return t.skip(`real embedder unavailable: ${realEmbedderUnavailable}`);
  const tmpRoot = mkdtempSync(join(tmpdir(), "brain-oneshot-"));
  try {
    assertCleanExitWithRetry(tmpRoot, oneShotChildScript(join(tmpRoot, "store")));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("MCP MemoryGate: idle release right after an embedding write does not crash", { timeout: 90_000 }, (t) => {
  if (realEmbedderUnavailable) return t.skip(`real embedder unavailable: ${realEmbedderUnavailable}`);
  const tmpRoot = mkdtempSync(join(tmpdir(), "brain-gate-idle-"));
  try {
    assertCleanExitWithRetry(tmpRoot, gateChildScript(join(tmpRoot, "store")));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
