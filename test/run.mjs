/**
 * Test runner for the_brain.
 *
 * Runs each test file in its own process (per-file isolation is required so the
 * native onnxruntime/Kuzu state doesn't accumulate) and judges pass/fail by the
 * actual subtest results, NOT the process exit code.
 *
 * Why: the embedding/graph native libraries intermittently crash in their
 * destructors at process exit (`libc++abi: mutex lock failed`) AFTER all tests
 * have passed. That makes the exit code unreliable, but the reported test
 * results are correct. We treat a file as failed only if a named subtest fails
 * or the run produced no summary (a genuine mid-test crash).
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = readdirSync("test")
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => `test/${f}`);

let failedFiles = 0;
let totalPass = 0;

for (const file of files) {
  const r = spawnSync("node", ["--import", "tsx", "--test", "--test-reporter=spec", file], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // Use the deterministic hashing embedding by default so the suite doesn't
    // load the native ONNX model in every process (unstable across many
    // short-lived processes). The dedicated embedder test opts back out.
    env: { ...process.env, BRAIN_FAKE_EMBED: process.env.BRAIN_FAKE_EMBED ?? "1" },
  });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;

  const passed = [...out.matchAll(/^[\s]*✔ /gm)].length;
  // Real failures: ✖ lines for named subtests, which carry a "(123ms)" duration.
  // Excluded: the file-level wrapper line (contains ".test.ts" — reflects only
  // the exit-time native crash) and the reporter's "✖ failing tests:" header
  // (no duration).
  const realFails = [...out.matchAll(/^[\s]*✖ (.+\(\d[\d.]*ms\))\s*$/gm)]
    .map((m) => m[1])
    .filter((s) => !s.includes(".test.ts"));
  const hasSummary = /ℹ tests \d+/.test(out);

  const ok = realFails.length === 0 && hasSummary;
  totalPass += passed;
  if (ok) {
    console.log(`PASS  ${file}  (${passed} tests)`);
  } else {
    failedFiles++;
    console.log(`FAIL  ${file}`);
    if (!hasSummary) console.log("   ↳ no test summary — crashed mid-run");
    for (const f of realFails) console.log(`   ✖ ${f}`);
    // surface a little context on a hard crash
    if (!hasSummary) console.log(out.split("\n").filter((l) => /error|Error|exception|abort/i.test(l)).slice(0, 3).map((l) => "     " + l.trim()).join("\n"));
  }
}

console.log("");
if (failedFiles === 0) {
  console.log(`✅ All ${files.length} test files passed (${totalPass} tests).`);
  process.exit(0);
} else {
  console.log(`❌ ${failedFiles}/${files.length} test files failed.`);
  process.exit(1);
}
