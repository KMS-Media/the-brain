import { test } from "node:test";
import assert from "node:assert/strict";
import { combine, recencyScore, usageScore, WEIGHTS } from "../src/retrieval/ranking.js";

test("weights sum to 1.0 (PRD §10)", () => {
  const sum = WEIGHTS.semantic + WEIGHTS.graph + WEIGHTS.importance + WEIGHTS.usage + WEIGHTS.recency;
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}`);
});

test("recencyScore decays with age", () => {
  const now = Date.parse("2026-06-19T00:00:00Z");
  const today = recencyScore("2026-06-19T00:00:00", now);
  const monthAgo = recencyScore("2026-05-20T00:00:00", now); // ~30d → ~0.5
  const yearAgo = recencyScore("2025-06-19T00:00:00", now);
  assert.ok(today > monthAgo, "today more recent than a month ago");
  assert.ok(monthAgo > yearAgo, "month ago more recent than a year ago");
  assert.ok(Math.abs(monthAgo - 0.5) < 0.1, "30d half-life ~0.5");
});

test("recencyScore accepts Date objects (Kuzu TIMESTAMP)", () => {
  const now = Date.parse("2026-06-19T00:00:00Z");
  const s = recencyScore(new Date("2026-06-19T00:00:00Z"), now);
  assert.ok(s > 0.99, "a Date for today scores ~1");
});

test("usageScore is log-normalized and monotonic", () => {
  assert.equal(usageScore(0, 100), 0);
  const a = usageScore(5, 100);
  const b = usageScore(50, 100);
  assert.ok(b > a, "more usage scores higher");
  assert.ok(b <= 1, "never exceeds 1");
});

test("combine applies the weighted formula", () => {
  const now = Date.now();
  const r = combine(
    { semantic: 1, graphConnections: 4, importance: 1, usageCount: 10, updatedAt: new Date(now).toISOString() },
    { now, maxConnections: 4, maxUsage: 10 },
  );
  // semantic=1, graph=1, importance=1, usage≈1, recency≈1 → score ≈ 1
  assert.ok(r.score > 0.95, `near-perfect signals → high score, got ${r.score}`);
  assert.equal(r.semantic, 1);
  assert.equal(r.graph, 1);
});

test("semantic is the strongest single signal (0.40 weight)", () => {
  const now = Date.now();
  const base = { graphConnections: 2, importance: 0.5, usageCount: 2, updatedAt: new Date(now).toISOString() };
  const strong = combine({ ...base, semantic: 0.9 }, { now, maxConnections: 5, maxUsage: 5 });
  const weak = combine({ ...base, semantic: 0.2 }, { now, maxConnections: 5, maxUsage: 5 });
  // With all other signals equal, a 0.7 semantic gap moves the score by 0.7*0.40 = 0.28.
  assert.ok(strong.score > weak.score, "higher semantic wins when other signals are equal");
  assert.ok(Math.abs((strong.score - weak.score) - 0.7 * 0.4) < 1e-9, "delta equals semantic weight × gap");
});
