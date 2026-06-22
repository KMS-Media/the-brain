import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/core.js";
import { curate } from "../src/curate.js";

let dir: string;
let mem: Memory;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-curate-"));
  mem = await Memory.openAt(dir);
});
after(() => {
  mem?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("promotes a recurring finding into a coding standard with a VIOLATES link", async () => {
  await mem.repo.upsertNode("ReviewFinding", { id: "rf-1", rule: "never log secrets", severity: "high", fix: "use the redaction helper", frequency: 4 });
  await mem.repo.upsertNode("ReviewFinding", { id: "rf-2", rule: "rare one-off", severity: "low", frequency: 1 });

  const report = await curate(mem, { promoteFrequency: 3 });
  assert.equal(report.promoted.length, 1, "only the frequent finding is promoted");
  assert.equal(report.promoted[0].findingId, "rf-1");

  const standards = await mem.repo.allNodes("CodingStandard");
  assert.equal(standards.length, 1, "one standard created");
  assert.match(String(standards[0].name), /never log secrets/);

  const link = await mem.db.query(`MATCH (f:ReviewFinding {id:'rf-1'})-[:VIOLATES]->(s:CodingStandard) RETURN s.id AS id;`);
  assert.equal(link.length, 1, "VIOLATES link created");
});

test("promotion is idempotent (stable standard id)", async () => {
  await curate(mem, { promoteFrequency: 3 });
  const standards = await mem.repo.allNodes("CodingStandard");
  assert.equal(standards.length, 1, "no duplicate standard on re-run");
});

test("dry-run promotes nothing", async () => {
  await mem.repo.upsertNode("ReviewFinding", { id: "rf-3", rule: "frequent dryrun finding", severity: "medium", frequency: 9 });
  const before = (await mem.repo.allNodes("CodingStandard")).length;
  const report = await curate(mem, { promoteFrequency: 3, dryRun: true });
  assert.ok(report.promoted.length >= 1, "reports what would be promoted");
  assert.equal((await mem.repo.allNodes("CodingStandard")).length, before, "nothing created in dry-run");
});

test("prune removes stale, unused, low-importance knowledge only when enabled", async () => {
  await mem.repo.upsertNode("Knowledge", { id: "stale", title: "obsolete note", content: "old", importance: 0.1, usageCount: 0 });
  // backdate it well past the age cutoff
  await mem.db.query(`MATCH (n:Knowledge {id:'stale'}) SET n.updatedAt = timestamp('2000-01-01T00:00:00');`);
  await mem.repo.upsertNode("Knowledge", { id: "important", title: "keep me", content: "load-bearing", importance: 0.9 });

  const noPrune = await curate(mem, { prune: false });
  assert.equal(noPrune.pruned.length, 0, "prune off by default");
  assert.ok(await mem.repo.getNode("Knowledge", "stale"));

  const withPrune = await curate(mem, { prune: true, pruneMaxAgeDays: 30 });
  assert.ok(withPrune.pruned.some((p) => p.id === "stale"), "stale node pruned");
  assert.equal(await mem.repo.getNode("Knowledge", "stale"), null);
  assert.ok(await mem.repo.getNode("Knowledge", "important"), "important node kept");
});
