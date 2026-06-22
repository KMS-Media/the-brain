import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/core.js";
import { exportBundle, importBundle } from "../src/share.js";

let dirA: string;
let dirB: string;
let a: Memory;
let b: Memory;

before(async () => {
  dirA = mkdtempSync(join(tmpdir(), "brain-shareA-"));
  dirB = mkdtempSync(join(tmpdir(), "brain-shareB-"));
  a = await Memory.openAt(dirA);
  b = await Memory.openAt(dirB);
  // Source project has a decision affecting a component.
  const { id: comp } = await a.repo.upsertNode("Component", { id: "comp-auth", name: "AuthService", type: "Service" });
  const { id: dec } = await a.repo.upsertNode("Decision", { id: "dec-oauth", title: "Use OAuth2", decision: "auth code flow", importance: 0.9 });
  await a.repo.relate("Decision", dec, "AFFECTS", "Component", comp);
  await a.repo.upsertNode("ReviewFinding", { id: "f1", rule: "validate redirect uri", severity: "high", frequency: 3 });
});

after(() => {
  a?.close();
  b?.close();
  for (const d of [dirA, dirB]) if (d) rmSync(d, { recursive: true, force: true });
});

test("exportBundle captures knowledge nodes + intra-set edges (no internals)", async () => {
  const bundle = await exportBundle(a);
  assert.ok(bundle.nodes.length >= 3, "component, decision, finding exported");
  const dec = bundle.nodes.find((n) => n.props.id === "dec-oauth")!;
  assert.equal(dec.props.embedding, undefined, "embedding not shipped");
  assert.equal(dec.props.importance, 0.9, "shared signals retained");
  const finding = bundle.nodes.find((n) => n.props.id === "f1")!;
  assert.equal(finding.props.frequency, 3, "frequency retained");
  const edge = bundle.edges.find((e) => e.type === "AFFECTS");
  assert.ok(edge && edge.from === "dec-oauth" && edge.to === "comp-auth", "AFFECTS edge exported with labels");
});

test("importBundle merges nodes + edges into another project, re-embedded", async () => {
  const bundle = await exportBundle(a);
  const res = await importBundle(b, bundle);
  assert.equal(res.nodes, bundle.nodes.length);

  // Node exists in B and is searchable (so it was re-embedded).
  const node = await b.repo.getNode("Decision", "dec-oauth");
  assert.ok(node && Array.isArray(node.embedding), "re-embedded on import");
  const hits = await b.search("oauth authentication decision", 10);
  assert.ok(hits.some((h) => h.id === "dec-oauth"), "imported decision is searchable");

  // Edge was recreated in B.
  const rows = await b.db.query(`MATCH (d:Decision {id:'dec-oauth'})-[:AFFECTS]->(c:Component {id:'comp-auth'}) RETURN c.id AS id;`);
  assert.equal(rows.length, 1, "AFFECTS edge imported");
});

test("import is idempotent on stable ids", async () => {
  const bundle = await exportBundle(a);
  await importBundle(b, bundle);
  const cnt = await b.db.query(`MATCH (d:Decision) RETURN count(d) AS n;`);
  assert.equal(Number(cnt[0].n), 1, "re-import does not duplicate");
});
