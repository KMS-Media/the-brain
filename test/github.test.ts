import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/core.js";
import { issuesToNodes, pullsToNodes, referencedPrNumbers } from "../src/github.js";

test("issuesToNodes maps issues to Problem nodes, skipping malformed", () => {
  const nodes = issuesToNodes([
    { number: 12, title: "Login throws on empty password", body: "stack trace…", state: "open" },
    { number: NaN as unknown as number, title: "bad" },
    { number: 5 } as any,
  ]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].label, "Problem");
  assert.equal(nodes[0].props.id, "gh-issue-12");
  assert.match(String(nodes[0].props.title), /#12 Login throws/);
});

test("pullsToNodes maps PRs to Decision nodes", () => {
  const nodes = pullsToNodes([{ number: 42, title: "Adopt OAuth2", body: "switch to auth code flow", state: "merged" }]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].label, "Decision");
  assert.equal(nodes[0].props.id, "gh-pr-42");
  assert.equal(nodes[0].props.decision, "switch to auth code flow");
});

test("referencedPrNumbers extracts #N references from a commit message", () => {
  assert.deepEqual(referencedPrNumbers("fix login (#42); also relates to #7"), [42, 7]);
  assert.deepEqual(referencedPrNumbers("no refs here"), []);
});

test("ingested issues/PRs become searchable knowledge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-gh-"));
  const mem = await Memory.openAt(dir);
  try {
    // simulate what ingestGitHub does with parsed data (no gh dependency)
    for (const n of pullsToNodes([{ number: 42, title: "Adopt OAuth2 auth", body: "use authorization code flow" }])) {
      await mem.repo.upsertNode(n.label, n.props);
    }
    for (const n of issuesToNodes([{ number: 12, title: "session fixation vulnerability", body: "tokens not rotated" }])) {
      await mem.repo.upsertNode(n.label, n.props);
    }
    const hits = await mem.search("oauth authentication flow", 10);
    assert.ok(hits.some((h) => h.id === "gh-pr-42"), "PR decision searchable");
    const probs = await mem.repo.allNodes("Problem");
    assert.ok(probs.some((p) => p.id === "gh-issue-12"));
  } finally {
    mem.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
