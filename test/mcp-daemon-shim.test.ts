import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createShim } from "../src/mcp/shim.js";

/**
 * End-to-end regression for the daemon/shim split (see src/mcp/daemon.ts and
 * src/mcp/shim.ts): a single shared daemon process serving the actual Kuzu
 * store, with a thin per-client shim in front that must survive the daemon
 * dying mid-session.
 *
 * The daemon MUST run in its own child process here, not in-process with the
 * test: co-locating the daemon's real Kuzu handle with an HTTP client hitting
 * it in the same process reliably segfaulted while this was being built
 * (undici + native Kuzu teardown interaction, reproduced 3/3) — even though
 * the real two-separate-processes deployment topology never did (also 3/3
 * clean). This test intentionally uses that same, safe, realistic topology:
 * daemon in a forked child, shim + fake IDE client in the test process (the
 * shim itself holds no native handles, so it's safe to run in-process).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHILD_SCRIPT = join(ROOT, "test/fixtures/daemon-child.mjs");
const PORT = 18961;

let dir: string;
let daemonChild: ChildProcess | null = null;

function spawnDaemon(): Promise<ChildProcess> {
  const child = fork(CHILD_SCRIPT, [dir, String(PORT)], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  daemonChild = child;
  return new Promise((resolve, reject) => {
    child.once("message", () => resolve(child));
    child.once("exit", (code, signal) => reject(new Error(`daemon child exited early (code=${code}, signal=${signal})`)));
  });
}

function killDaemon(): Promise<void> {
  return new Promise((resolve) => {
    if (!daemonChild) return resolve();
    daemonChild.once("exit", () => resolve());
    daemonChild.kill("SIGKILL");
    daemonChild = null;
  });
}

after(() => {
  daemonChild?.kill("SIGKILL");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test(
  "shim survives a daemon crash and recovers once a fresh daemon is reachable",
  { timeout: 60_000 },
  async () => {
    dir = mkdtempSync(join(tmpdir(), "brain-daemon-shim-"));
    await spawnDaemon();

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const shim = createShim(`http://127.0.0.1:${PORT}/mcp`);
    await shim.connect(serverSide);

    const ideClient = new Client({ name: "test-ide", version: "1.0" });
    let ideClientClosed = false;
    clientSide.onclose = () => {
      ideClientClosed = true;
    };
    await ideClient.connect(clientSide);

    const r1 = await ideClient.callTool({ name: "remember_knowledge", arguments: { title: "before", content: "daemon is up" } });
    assert.equal(r1.isError, undefined, "call succeeds while the daemon is up");

    await killDaemon();
    await new Promise((r) => setTimeout(r, 300));

    // The core guarantee: the local (IDE-facing) transport must still be open,
    // and the failed call must come back as a normal tool result, not a thrown
    // error or a torn-down connection.
    const r2 = await ideClient.callTool({ name: "remember_knowledge", arguments: { title: "during", content: "daemon is down" } });
    assert.equal(r2.isError, true, "call surfaces as a clean tool error while the daemon is down");
    assert.equal(ideClientClosed, false, "the shim's client-facing transport never closes because the daemon died");

    await spawnDaemon();
    const r3 = await ideClient.callTool({ name: "remember_knowledge", arguments: { title: "after", content: "daemon is back" } });
    assert.equal(r3.isError, undefined, "the same shim/client reconnects transparently once the daemon is reachable again");
  },
);
