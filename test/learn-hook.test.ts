import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/core.js";
import { learn } from "../src/learning/extractor.js";
import { handleStop, lastAssistantText } from "../src/hooks/learn.js";

let store: string;

before(() => {
  store = mkdtempSync(join(tmpdir(), "brain-learnhook-"));
});
after(() => {
  if (store) rmSync(store, { recursive: true, force: true });
});

test("learn() is idempotent and accumulates finding frequency (PRD §13)", async () => {
  const mem = await Memory.openAt(store);
  const text = "FINDING[high]: do not commit secrets -> use env vars";
  await learn(mem, text);
  await learn(mem, text); // same finding again
  await learn(mem, text);

  const rows = await mem.db.query(`MATCH (f:ReviewFinding) RETURN count(f) AS n;`);
  assert.equal(Number(rows[0].n), 1, "identical finding stored once");

  const node = (await mem.db.query(`MATCH (f:ReviewFinding) RETURN f;`))[0].f as Record<string, unknown>;
  assert.equal(Number(node.frequency), 3, "frequency accumulated to 3");
  mem.close();
});

test("lastAssistantText extracts the most recent assistant turn", () => {
  const transcript = join(store, "transcript.jsonl");
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "build the auth flow" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "first answer" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "and findings?" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "FINDING[medium]: token not validated -> verify exp claim" }] } }),
    ].join("\n") + "\n",
  );
  const text = lastAssistantText(transcript);
  assert.match(text, /token not validated/);
  assert.doesNotMatch(text, /first answer/, "only the last assistant turn");
});

test("handleStop learns markers from the last assistant turn", async () => {
  const transcript = join(store, "t-learn.jsonl");
  writeFileSync(
    transcript,
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done.\nDECISION: Use httpOnly cookies | safer than localStorage\nFINDING[medium]: token not validated -> verify exp claim" }],
      },
    }) + "\n",
  );

  // Isolate the store via BRAIN_HOME; a fixed projectPath keeps the slug stable.
  const hookStore = join(store, "hookhome");
  const projectPath = join(store, "fake-project");
  process.env.BRAIN_HOME = hookStore;
  const learned = await handleStop({ transcript_path: transcript, cwd: projectPath, stop_hook_active: false });
  assert.equal(learned.length, 2, "decision + finding learned");

  const mem = await Memory.open(projectPath);
  try {
    const decisions = await mem.db.query(`MATCH (d:Decision) WHERE d.title = 'Use httpOnly cookies' RETURN d;`);
    const findings = await mem.db.query(`MATCH (f:ReviewFinding) WHERE f.rule = 'token not validated' RETURN f;`);
    assert.equal(decisions.length, 1, "decision persisted");
    assert.equal(findings.length, 1, "finding persisted");
  } finally {
    mem.close();
  }
});

test("handleStop does nothing when stop_hook_active is set (loop guard)", async () => {
  const transcript = join(store, "t-guard.jsonl");
  writeFileSync(
    transcript,
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "FINDING: guarded -> skip" }] } }) + "\n",
  );
  const learned = await handleStop({ transcript_path: transcript, cwd: join(store, "guard-project"), stop_hook_active: true });
  assert.equal(learned.length, 0, "nothing learned when stop_hook_active");
});
