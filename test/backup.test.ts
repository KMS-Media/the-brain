import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/core.js";
import { restoreDatabase, isEncrypted } from "../src/backup.js";

let store: string;
let backups: string;
let mem: Memory; // single long-lived handle on `store` (one Database per path)

before(async () => {
  store = mkdtempSync(join(tmpdir(), "brain-bk-store-"));
  backups = mkdtempSync(join(tmpdir(), "brain-bk-out-"));
  mem = await Memory.openAt(store);
  await mem.repo.upsertNode("Decision", { id: "d-keep", title: "Persisted decision", decision: "keep me" });
});
after(() => {
  mem?.close();
  for (const d of [store, backups]) if (d) rmSync(d, { recursive: true, force: true });
});

async function backup(stamp: string, passphrase?: string) {
  return mem.backup(backups, stamp, passphrase);
}

/** Read the seeded title from a restored copy (a fresh path → its own Database). */
async function readTitle(dir: string): Promise<unknown> {
  const m = await Memory.openAt(dir);
  const node = await m.repo.getNode("Decision", "d-keep");
  m.close();
  return node?.title;
}

test("encrypted backup round-trips and is unreadable without the key", async () => {
  const res = await backup("enc", "correct horse battery staple");
  assert.ok(res.encrypted && res.path.endsWith(".enc"));
  assert.ok(isEncrypted(res.path), "file carries the encrypted magic header");
  // Ciphertext must not contain the plaintext title.
  assert.equal(readFileSync(res.path).includes(Buffer.from("Persisted decision")), false);

  const dest = mkdtempSync(join(tmpdir(), "brain-bk-r1-"));
  restoreDatabase(res.path, dest, "correct horse battery staple");
  assert.equal(await readTitle(dest), "Persisted decision");
  rmSync(dest, { recursive: true, force: true });
});

test("restore with the wrong passphrase fails (auth tag)", async () => {
  const res = await backup("enc2", "the right key");
  const dest = mkdtempSync(join(tmpdir(), "brain-bk-r2-"));
  assert.throws(() => restoreDatabase(res.path, dest, "the WRONG key"));
  rmSync(dest, { recursive: true, force: true });
});

test("plaintext backup round-trips when no passphrase is given", async () => {
  const res = await backup("plain");
  assert.equal(res.encrypted, false);
  assert.ok(!res.path.endsWith(".enc"));
  assert.equal(isEncrypted(res.path), false);

  const dest = mkdtempSync(join(tmpdir(), "brain-bk-r3-"));
  restoreDatabase(res.path, dest);
  assert.equal(await readTitle(dest), "Persisted decision");
  rmSync(dest, { recursive: true, force: true });
});
