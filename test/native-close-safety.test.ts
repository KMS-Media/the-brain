import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression test for Issue.md: a one-shot process (CLI command, Stop hook)
 * that opens Memory, does a knowledge-bearing write (triggers the real ONNX
 * embedder), and calls close() right in the same continuation, used to
 * segfault (SIGSEGV) almost every time — GraphDB.close() called the native
 * Kuzu closeSync() teardown immediately after an embedding call, racing the
 * embedder's background native cleanup.
 *
 * Direct testing disproved the issue's own hypothesis (a `tags STRING[]`
 * parameter-binding crash): identical writes with and without `tags` crashed
 * at the same near-100% rate, and binding a STRING[] parameter alone (no
 * embedding involved) never crashed. The real trigger was the immediate
 * native close after ANY embedding write, independent of `tags`. The fix
 * (src/db/kuzu.ts GraphDB.close) makes one-shot processes release only the
 * advisory lock and skip the native teardown, since the OS reclaims native
 * handles on process exit anyway.
 *
 * Must use the real embedder (BRAIN_FAKE_EMBED=0) — the crash never occurs
 * with the fake hashing embedder used elsewhere in the suite. Each variant
 * runs a few times and requires a majority to exit cleanly: pre-fix this
 * crashed on virtually every run, post-fix only a rare, pre-existing
 * ONNX/Kuzu exit-time race (documented in test/run.mjs) remains possible.
 */

const ROOT = join(import.meta.dirname, "..");

function oneShotChildScript(storeDir: string, tags?: string[]): string {
  const tagsLine = tags ? `tags: ${JSON.stringify(tags)},` : "";
  return `
    import { Memory } from ${JSON.stringify(join(ROOT, "src/core.ts"))};
    const memory = await Memory.openAt(${JSON.stringify(storeDir)});
    await memory.repo.upsertNode("Knowledge", {
      title: "one-shot close() regression",
      content: "content long enough to need a real embedding computation",
      ${tagsLine}
    });
    // Mirrors src/bin/brain.ts and src/hooks/learn.ts: close() called
    // synchronously right after the embedding-triggering write resolves.
    memory.close();
  `;
}

function runOneShot(storeDir: string, tags?: string[]) {
  const scriptPath = join(storeDir, "child.mjs");
  writeFileSync(scriptPath, oneShotChildScript(storeDir, tags));
  return spawnSync("node", ["--import", "tsx", scriptPath], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env, BRAIN_FAKE_EMBED: "0" },
    timeout: 30_000,
  });
}

function assertMajorityCleanExit(storeDir: string, tags: string[] | undefined, runs: number): void {
  const results = Array.from({ length: runs }, () => runOneShot(storeDir, tags));
  const clean = results.filter((r) => r.status === 0);
  const crashed = results.filter((r) => r.status !== 0);
  assert.ok(
    clean.length > crashed.length,
    `expected a majority of ${runs} one-shot runs to exit cleanly, got ${clean.length} clean / ${crashed.length} crashed ` +
      `(statuses: ${results.map((r) => r.status ?? `signal ${r.signal}`).join(", ")}). ` +
      `stderr of first crash:\n${crashed[0]?.stderr ?? ""}`,
  );
}

test(
  "one-shot process: close() after a Knowledge write WITH tags does not crash",
  { timeout: 90_000 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-oneshot-tags-"));
    try {
      assertMajorityCleanExit(dir, ["EA-7983", "docker", "migration"], 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "one-shot process: close() after a Knowledge write WITHOUT tags does not crash",
  { timeout: 90_000 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-oneshot-notags-"));
    try {
      assertMajorityCleanExit(dir, undefined, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
