import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/core.js";
import { listProjects, searchAcrossProjects, transferNode, findProject } from "../src/multi.js";

let home: string;

before(async () => {
  home = mkdtempSync(join(tmpdir(), "brain-multi-"));
  // Two project stores under the memory home.
  const alpha = join(home, "alpha");
  const beta = join(home, "beta");
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });

  const a = await Memory.openAt(alpha);
  await a.repo.upsertNode("Decision", { id: "a1", title: "Use OAuth2 for authentication", decision: "OAuth2 auth code flow" });
  a.close();

  const b = await Memory.openAt(beta);
  await b.repo.upsertNode("Knowledge", { id: "b1", title: "CSS theming", content: "dark mode via variables" });
  b.close();
});

after(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

test("listProjects discovers all stores under the memory home", () => {
  const projects = listProjects(home);
  const names = projects.map((p) => p.name).sort();
  assert.deepEqual(names, ["alpha", "beta"]);
});

test("searchAcrossProjects federates and tags results by project", async () => {
  const hits = await searchAcrossProjects("how do we handle login authentication", 10, home);
  assert.ok(hits.length > 0);
  const top = hits[0];
  assert.equal(top.project, "alpha", "auth decision in alpha ranks first");
  assert.match(String(top.props.title), /OAuth2/);
  // every hit carries a project tag
  assert.ok(hits.every((h) => typeof h.project === "string" && h.project.length > 0));
});

test("transferNode copies a node into another project with a fresh embedding", async () => {
  const alpha = findProject("alpha", home)!;
  const beta = findProject("beta", home)!;
  const res = await transferNode(alpha, beta, "Decision", "a1");
  assert.equal(res.to, "beta");

  // The decision now exists in beta and is findable there.
  const b = await Memory.openAt(beta.storageDir);
  const hits = await b.search("authentication oauth login", 10);
  b.close();
  assert.ok(hits.some((h) => h.label === "Decision" && String(h.props.title).includes("OAuth2")), "transferred decision is searchable in beta");
});
