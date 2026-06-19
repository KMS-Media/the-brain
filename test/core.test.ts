import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/core.js";
import { extract, learn } from "../src/learning/extractor.js";

let dir: string;
let mem: Memory;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-test-"));
  mem = await Memory.openAt(dir);
});

after(() => {
  mem?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("upsert + getNode round-trips a Decision with embedding", async () => {
  const { id } = await mem.repo.upsertNode("Decision", {
    title: "Use Kuzu for the graph store",
    problem: "Need embedded local graph DB",
    decision: "Adopt Kuzu",
    reasoning: "Embedded, fast, Cypher-like",
  });
  const node = await mem.repo.getNode("Decision", id);
  assert.ok(node, "node should exist");
  assert.equal(node!.title, "Use Kuzu for the graph store");
  assert.ok(Array.isArray(node!.embedding), "embedding stored");
  assert.equal((node!.embedding as number[]).length, 384);
  assert.equal(node!.embeddingModel, "Xenova/bge-small-en-v1.5", "embedding model recorded (PRD §15)");
  assert.equal(node!.embeddingVersion, "1", "embedding version recorded (PRD §15)");
});

test("semantic search ranks the relevant node first", async () => {
  await mem.repo.upsertNode("Knowledge", { title: "OAuth flow", content: "We use OAuth2 authorization code for login" });
  await mem.repo.upsertNode("Knowledge", { title: "CSS theming", content: "Dark mode via CSS variables" });
  const hits = await mem.search("how does authentication / OAuth login work", 5);
  assert.ok(hits.length > 0, "should return hits");
  const top = hits[0];
  assert.match(String(top.props.title ?? top.props.content ?? ""), /OAuth/i);
});

test("review findings are prioritized in the context block", async () => {
  await mem.repo.upsertNode("ReviewFinding", {
    severity: "high",
    rule: "Do not log secrets in the UserService",
    fix: "Use the redaction helper",
  });
  await mem.repo.upsertNode("Knowledge", { title: "UserService overview", content: "Handles user accounts and secrets" });
  const ctx = await mem.context("working on the UserService logging");
  assert.ok(ctx.markdown.includes("Review Findings"), "findings section present");
  // Findings section must appear before Knowledge in the markdown.
  const fi = ctx.markdown.indexOf("Review Findings");
  const ki = ctx.markdown.indexOf("Projektwissen");
  if (ki !== -1) assert.ok(fi < ki, "findings appear before knowledge");
});

test("component lookup traverses decisions, deps, findings, experiences", async () => {
  const { id: compId } = await mem.repo.upsertNode("Component", { name: "UserService", type: "Service" });
  const { id: depId } = await mem.repo.upsertNode("Component", { name: "AuthLib", type: "Library" });
  const { id: decId } = await mem.repo.upsertNode("Decision", { title: "Token storage", decision: "Use httpOnly cookies" });
  const { id: findId } = await mem.repo.upsertNode("ReviewFinding", { rule: "Validate JWT exp", severity: "medium" });
  const { id: probId } = await mem.repo.upsertNode("Problem", { title: "Session fixation" });
  const { id: expId } = await mem.repo.upsertNode("Experience", { problem: "Sessions leaked", solution: "Rotate tokens" });

  await mem.repo.relate("Component", compId, "DEPENDS_ON", "Component", depId);
  await mem.repo.relate("Decision", decId, "AFFECTS", "Component", compId);
  await mem.repo.relate("ReviewFinding", findId, "AFFECTS", "Component", compId);
  await mem.repo.relate("Experience", expId, "SOLVES", "Problem", probId);
  await mem.repo.relate("Experience", expId, "RELATES_TO", "Component", compId);

  const res = await mem.component("UserService");
  assert.ok(res.component, "component found");
  assert.equal(res.dependencies.length, 1, "one dependency");
  assert.equal(res.dependencies[0].name, "AuthLib");
  assert.equal(res.decisions.length, 1, "one decision");
  assert.equal(res.findings.length, 1, "one finding");
  assert.equal(res.experiences.length, 1, "one experience");
});

test("extractor parses markers and learn() persists them", async () => {
  const text = [
    "DECISION: Adopt GraphQL | because Claude talks only over GraphQL",
    "FINDING[high]: Missing input validation -> add zod schema",
    "LEARNED: Race condition in cache -> add a mutex",
    "RULE: No console.log in MCP server | corrupts stdio",
    "NOTE: Storage path | data lives under ~/.claude-memory",
  ].join("\n");
  const items = extract(text);
  assert.equal(items.length, 5, "five items extracted");

  const created = await learn(mem, text);
  assert.equal(created.length, 5, "five nodes persisted");
});

test("upsert is idempotent on explicit id", async () => {
  const a = await mem.repo.upsertNode("CodingStandard", { id: "std-1", name: "Naming", description: "camelCase" });
  const b = await mem.repo.upsertNode("CodingStandard", { id: "std-1", name: "Naming", description: "use camelCase consistently" });
  assert.equal(a.id, b.id);
  const node = await mem.repo.getNode("CodingStandard", "std-1");
  assert.equal(node!.description, "use camelCase consistently");
});
