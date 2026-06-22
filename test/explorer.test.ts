import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/core.js";
import { exportGraph, renderHtml } from "../src/explorer.js";

let dir: string;
let mem: Memory;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-explore-"));
  mem = await Memory.openAt(dir);
  const { id: comp } = await mem.repo.upsertNode("Component", { name: "UserService", type: "Service" });
  const { id: dec } = await mem.repo.upsertNode("Decision", { title: "Token storage", decision: "httpOnly cookies" });
  await mem.repo.relate("Decision", dec, "AFFECTS", "Component", comp);
});

after(() => {
  mem?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("exportGraph returns nodes and edges within the included set", async () => {
  const data = await exportGraph(mem);
  const labels = data.nodes.map((n) => n.label).sort();
  assert.ok(labels.includes("Component"));
  assert.ok(labels.includes("Decision"));
  // the AFFECTS edge is present and both endpoints are in the node set
  const affects = data.edges.find((e) => e.type === "AFFECTS");
  assert.ok(affects, "AFFECTS edge exported");
  const ids = new Set(data.nodes.map((n) => n.id));
  assert.ok(ids.has(affects!.from) && ids.has(affects!.to), "edge endpoints are included nodes");
});

test("renderHtml produces a self-contained document with embedded data", async () => {
  const data = await exportGraph(mem);
  const html = renderHtml(data, "demo-project");
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes("demo-project"), "project name in title");
  assert.ok(html.includes("UserService"), "node data embedded");
  // self-contained: no external resource references
  assert.doesNotMatch(html, /src=["']https?:/i);
  assert.doesNotMatch(html, /href=["']https?:/i);
});

test("exportGraph excludes structural nodes unless requested", async () => {
  // add a File node + CONTAINS structure
  await mem.repo.upsertNode("Directory", { id: "src", path: "src" });
  await mem.repo.upsertNode("File", { id: "src/x.ts", path: "src/x.ts", language: "TypeScript" });
  const def = await exportGraph(mem);
  assert.ok(!def.nodes.some((n) => n.label === "File"), "files excluded by default");
  const all = await exportGraph(mem, { includeStructure: true });
  assert.ok(all.nodes.some((n) => n.label === "File"), "files included with includeStructure");
});
