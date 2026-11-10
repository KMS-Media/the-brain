import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/core.js";

// Regression: unclosed native QueryResults were finalized by the GC after
// Database.closeSync(), segfaulting the process (~FactorizedTable) a few
// open/close cycles later — the cause of the recurring MCP disconnects.
test("repeated open/query/dispose cycles do not crash the process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-qr-"));
  try {
    for (let i = 0; i < 15; i++) {
      const m = await Memory.openAt(dir);
      await m.repo.upsertNode("Knowledge", { title: `t${i}`, content: `c${i}` });
      await m.search("t", 5);
      await m.disposeSafely();
      globalThis.gc?.();
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
