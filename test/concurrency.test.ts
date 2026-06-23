import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/core.js";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-concur-"));
});
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("dispose() releases the lock so the same store can be reopened", { timeout: 15000 }, async () => {
  const a = await Memory.openAt(dir);
  await a.repo.upsertNode("Knowledge", { id: "k1", title: "first", content: "hello" });
  a.dispose();

  // A second open of the same store must succeed (lock was released).
  const b = await Memory.openAt(dir);
  const node = await b.repo.getNode("Knowledge", "k1");
  assert.equal(node?.title, "first", "data persisted and store reopened");
  b.dispose();

  assert.equal(existsSync(join(dir, ".brain.lock")), false, "lockfile removed after dispose");
});

test("re-entrant open in the same process does not deadlock (ref-counted lock)", { timeout: 15000 }, async () => {
  // Opening the same store twice in one process must not hang and must
  // ref-count the lockfile (Kuzu permits multiple handles within a process;
  // two handles don't share uncommitted state, so we only assert lock behavior).
  const a = await Memory.openAt(dir);
  const b = await Memory.openAt(dir); // would hang if the lock weren't re-entrant
  assert.equal(existsSync(join(dir, ".brain.lock")), true, "lock held while open");
  a.dispose();
  assert.equal(existsSync(join(dir, ".brain.lock")), true, "lock kept while another handle is open");
  b.dispose();
  assert.equal(existsSync(join(dir, ".brain.lock")), false, "lock released once the last handle closes");
});

test("many sequential open/dispose cycles stay stable", { timeout: 30000 }, async () => {
  for (let i = 0; i < 15; i++) {
    const m = await Memory.openAt(dir);
    await m.search("anything");
    m.dispose();
  }
  assert.ok(true, "no crash across repeated open/dispose");
});
