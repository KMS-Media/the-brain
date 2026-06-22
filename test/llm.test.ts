import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

let server: Server;
let lastBody: any;
let reply = "[]";

before(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      lastBody = JSON.parse(data);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  process.env.BRAIN_LLM_URL = `http://127.0.0.1:${port}/v1`;
  process.env.BRAIN_LLM_MODEL = "test-model";
});

after(() => {
  delete process.env.BRAIN_LLM_URL;
  delete process.env.BRAIN_LLM_MODEL;
  server?.close();
});

test("isLLMEnabled reflects configuration", async () => {
  const { isLLMEnabled } = await import("../src/llm.js");
  assert.equal(isLLMEnabled(), true);
});

test("chat() posts to the OpenAI-compatible endpoint and returns content", async () => {
  reply = "hello from local llm";
  const { chat } = await import("../src/llm.js");
  const out = await chat([{ role: "user", content: "hi" }]);
  assert.equal(out, "hello from local llm");
  assert.equal(lastBody.model, "test-model");
  assert.equal(lastBody.messages[0].content, "hi");
});

test("extractWithLLM parses a JSON array (incl. fenced) into typed items", async () => {
  reply = "```json\n[{\"type\":\"Decision\",\"title\":\"Adopt Kuzu\",\"decision\":\"use Kuzu\"},{\"type\":\"Nonsense\",\"x\":1},{\"type\":\"ReviewFinding\",\"rule\":\"validate input\",\"severity\":\"high\"}]\n```";
  const { extractWithLLM } = await import("../src/llm.js");
  const items = await extractWithLLM("some response text");
  const labels = items.map((i) => i.label).sort();
  assert.deepEqual(labels, ["Decision", "ReviewFinding"], "invalid types dropped");
  assert.equal(items.find((i) => i.label === "Decision")!.props.title, "Adopt Kuzu");
});

test("extractWithLLM returns [] on unparseable output", async () => {
  reply = "I could not find anything useful.";
  const { extractWithLLM } = await import("../src/llm.js");
  assert.deepEqual(await extractWithLLM("text"), []);
});
