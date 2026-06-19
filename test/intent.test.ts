import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeIntent } from "../src/retrieval/intent.js";

test("detects review/bug intent", () => {
  const i = analyzeIntent("there's a security bug in the login, how do we fix it?");
  assert.ok(i.focus.includes("ReviewFinding"));
  assert.ok((i.boost.ReviewFinding ?? 0) > 0);
});

test("detects architecture/decision intent", () => {
  const i = analyzeIntent("what was the rationale for this design decision / ADR?");
  assert.ok(i.focus.includes("Decision"));
});

test("detects coding-standard intent", () => {
  const i = analyzeIntent("what is our naming convention and formatting style?");
  assert.ok(i.focus.includes("CodingStandard"));
});

test("detects component intent", () => {
  const i = analyzeIntent("how does the UserService api depend on the auth module?");
  assert.ok(i.focus.includes("Component"));
});

test("neutral prompt produces no focus", () => {
  const i = analyzeIntent("hello there");
  assert.equal(i.focus.length, 0);
  assert.deepEqual(i.boost, {});
});
