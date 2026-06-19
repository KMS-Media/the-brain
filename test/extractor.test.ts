import { test } from "node:test";
import assert from "node:assert/strict";
import { extract } from "../src/learning/extractor.js";

test("extracts each marker type", () => {
  const items = extract(
    [
      "ADR: Use Kuzu | embedded graph",
      "FINDING[critical]: Hardcoded secret -> move to env var",
      "ERFAHRUNG: Flaky test -> increase timeout",
      "REGEL: Always validate input | with zod",
      "WISSEN: Deploy target | runs on Node LTS",
      "just some prose that should not match",
    ].join("\n"),
  );
  const labels = items.map((i) => i.label).sort();
  assert.deepEqual(labels, ["CodingStandard", "Decision", "Experience", "Knowledge", "ReviewFinding"]);
});

test("captures severity and fix on a finding", () => {
  const [f] = extract("FINDING[high]: SQL injection -> parameterize");
  assert.equal(f.label, "ReviewFinding");
  assert.equal(f.props.severity, "high");
  assert.equal(f.props.rule, "SQL injection");
  assert.equal(f.props.fix, "parameterize");
});

test("defaults finding severity to medium", () => {
  const [f] = extract("FINDING: Missing null check");
  assert.equal(f.props.severity, "medium");
});

test("ignores non-marker text", () => {
  assert.equal(extract("This is a normal paragraph with no markers.").length, 0);
});
