import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHIM = join(ROOT, "src/mcp/shim.ts");
const EXIT_DEADLINE_MS = 5_000;

const activeChildren = new Set<ChildProcess>();
const tmpDirs = new Set<string>();

after(() => {
  for (const child of activeChildren) child.kill("SIGKILL");
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function spawnShim(crashLog: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", SHIM], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BRAIN_CRASH_LOG: crashLog, BRAIN_DAEMON_URL: "http://127.0.0.1:1/mcp" },
  });
  activeChildren.add(child);
  child.once("exit", () => activeChildren.delete(child));
  return new Promise((resolve, reject) => {
    child.stderr!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("shim running")) resolve(child);
    });
    child.once("exit", (code, signal) => reject(new Error(`shim exited before it was ready (code=${code}, signal=${signal})`)));
  });
}

function exitsWithin(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function crashLogPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-guards-"));
  tmpDirs.add(dir);
  return join(dir, "mcp-crash.log");
}

test("shim exits when the client's output pipes are gone instead of staying alive on EPIPE", { timeout: 30_000 }, async () => {
  const crashLog = crashLogPath();
  const child = await spawnShim(crashLog);

  child.stdout!.destroy();
  child.stderr!.destroy();
  child.stdin!.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gone", version: "0" } },
    }) + "\n",
  );

  const exited = await exitsWithin(child, EXIT_DEADLINE_MS);
  if (!exited) child.kill("SIGKILL");

  assert.equal(exited, true, `shim is still running ${EXIT_DEADLINE_MS} ms after its output pipes closed`);
  assert.match(readFileSync(crashLog, "utf8"), /"event":"stdio_peer_gone"/);
});
