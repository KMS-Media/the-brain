import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext } from "../src/retrieval/contextBuilder.js";
import type { ScoredNode } from "../src/types.js";

function finding(id: string, rule: string, score: number): ScoredNode {
  return {
    label: "ReviewFinding",
    id,
    props: { id, severity: "high", rule, fix: "do the thing" },
    score,
    breakdown: { semantic: score, graph: 0, importance: 0.5, usage: 0, recency: 0.5 },
  };
}

test("merges near-identical findings, keeping the higher-scored one (PRD §12)", () => {
  const ranked: ScoredNode[] = [
    finding("f1", "missing input validation on the search endpoint", 0.9),
    finding("f2", "input validation missing on the search endpoint", 0.7), // re-phrasing → duplicate
    finding("f3", "hardcoded database password in config", 0.6), // distinct
  ];
  const { context, used } = buildContext("review", ranked);
  assert.equal(context.findings.length, 2, "two distinct findings after merge");
  assert.equal(used.filter((u) => u.label === "ReviewFinding").length, 2);
  // the higher-scored phrasing survives
  assert.ok(context.findings.some((l) => l.includes("missing input validation")));
  assert.ok(!context.findings.some((l) => l.includes("input validation missing")));
});

test("does not merge genuinely different findings", () => {
  const ranked: ScoredNode[] = [
    finding("f1", "SQL injection in the orders query", 0.9),
    finding("f2", "cross-site scripting in the comment field", 0.8),
  ];
  const { context } = buildContext("review", ranked);
  assert.equal(context.findings.length, 2);
});

test("does not merge across different labels", () => {
  const ranked: ScoredNode[] = [
    finding("f1", "use parameterized queries everywhere", 0.9),
    {
      label: "CodingStandard",
      id: "s1",
      props: { id: "s1", name: "use parameterized queries everywhere", description: "always" },
      score: 0.8,
      breakdown: { semantic: 0.8, graph: 0, importance: 0.5, usage: 0, recency: 0.5 },
    },
  ];
  const { context } = buildContext("review", ranked);
  assert.equal(context.findings.length, 1);
  assert.equal(context.standards.length, 1, "same wording but different label is kept");
});
