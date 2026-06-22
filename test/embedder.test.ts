import { test, before } from "node:test";
import assert from "node:assert/strict";

// This is the one test that exercises the REAL local embedding model (the rest
// of the suite uses the deterministic hashing embedding for stability). Opt out
// of fake mode before importing the embedder.
before(() => {
  process.env.BRAIN_FAKE_EMBED = "0";
});

test("real model produces a 384-dim normalized embedding", async () => {
  const { embed } = await import("../src/embeddings/embedder.js");
  const v = await embed("OAuth2 authentication for the user service");
  assert.equal(v.length, 384);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 0.01, "L2-normalized");
});

test("real model captures semantic similarity (related > unrelated)", async () => {
  const { embed, cosine } = await import("../src/embeddings/embedder.js");
  const a = await embed("How do we handle OAuth authentication in the UserService?");
  const related = await embed("OAuth login flow for the user service");
  const unrelated = await embed("The weather in Paris is sunny today");
  assert.ok(cosine(a, a) > 0.99, "self-similarity ~1");
  assert.ok(cosine(a, related) > cosine(a, unrelated), "related ranks above unrelated");
});
