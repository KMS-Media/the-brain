import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/core.js";
import { consolidate } from "../src/consolidate.js";

let dir: string;
let mem: Memory;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-consol-"));
  mem = await Memory.openAt(dir);
});
after(() => {
  mem?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function count(label: string): Promise<number> {
  const r = await mem.db.query(`MATCH (n:${label}) RETURN count(n) AS n;`);
  return Number(r[0].n);
}

test("merges identical-content duplicates and keeps the distinct node", async () => {
  // Two byte-identical decisions → identical embeddings (cosine 1.0) + one distinct.
  await mem.repo.upsertNode("Decision", { id: "dup-a", title: "Use OAuth2 for authentication", decision: "OAuth2 auth code flow", importance: 0.4, usageCount: 2 });
  await mem.repo.upsertNode("Decision", { id: "dup-b", title: "Use OAuth2 for authentication", decision: "OAuth2 auth code flow", importance: 0.8, usageCount: 5 });
  await mem.repo.upsertNode("Decision", { id: "distinct", title: "Pick PostgreSQL", decision: "use Postgres", importance: 0.5 });

  assert.equal(await count("Decision"), 3);
  const report = await consolidate(mem, { threshold: 0.98 });
  assert.equal(report.clustersMerged, 1, "one duplicate cluster");
  assert.equal(report.nodesRemoved, 1, "one node removed");
  assert.equal(await count("Decision"), 2, "duplicate gone, distinct kept");

  // Survivor is the higher-importance one, with usage accumulated.
  const survivor = await mem.repo.getNode("Decision", "dup-b");
  assert.ok(survivor, "higher-importance node survives");
  assert.equal(Number(survivor!.usageCount), 7, "usage accumulated (2+5)");
  assert.ok(await mem.repo.getNode("Decision", "distinct"), "distinct decision untouched");
  assert.equal(await mem.repo.getNode("Decision", "dup-a"), null, "duplicate deleted");
});

test("rewires the duplicate's relationships onto the survivor", async () => {
  const { id: comp } = await mem.repo.upsertNode("Component", { name: "AuthService", type: "Service" });
  // dup-c (lower importance) carries an AFFECTS edge; dup-d is the survivor.
  await mem.repo.upsertNode("Decision", { id: "dup-c", title: "Token rotation policy decided here", decision: "rotate tokens every 24h", importance: 0.3 });
  await mem.repo.upsertNode("Decision", { id: "dup-d", title: "Token rotation policy decided here", decision: "rotate tokens every 24h", importance: 0.9 });
  await mem.repo.relate("Decision", "dup-c", "AFFECTS", "Component", comp);

  await consolidate(mem, { threshold: 0.98 });

  // dup-d survives and now AFFECTS the component (edge moved from dup-c).
  assert.ok(await mem.repo.getNode("Decision", "dup-d"));
  assert.equal(await mem.repo.getNode("Decision", "dup-c"), null);
  const rows = await mem.db.query(`MATCH (d:Decision)-[:AFFECTS]->(c:Component {id: $id}) RETURN d.id AS id;`, { id: comp });
  assert.deepEqual(rows.map((r) => r.id), ["dup-d"], "AFFECTS edge rewired to survivor");
});

test("dry-run reports merges without modifying the graph", async () => {
  await mem.repo.upsertNode("Knowledge", { id: "k-a", title: "Deploy target", content: "the service runs on Node LTS in production" });
  await mem.repo.upsertNode("Knowledge", { id: "k-b", title: "Deploy target", content: "the service runs on Node LTS in production" });
  const before = await count("Knowledge");
  const report = await consolidate(mem, { threshold: 0.98, dryRun: true });
  assert.ok(report.dryRun);
  assert.ok(report.clustersMerged >= 1, "reports the duplicate cluster");
  assert.equal(await count("Knowledge"), before, "nothing actually removed in dry-run");
});

test("leaves genuinely distinct nodes alone", async () => {
  const before = await count("Decision");
  const report = await consolidate(mem, { threshold: 0.999, labels: ["Decision"] });
  // distinct + survivors from earlier tests are not near-identical at 0.999
  assert.equal(report.nodesRemoved, 0);
  assert.equal(await count("Decision"), before);
});
