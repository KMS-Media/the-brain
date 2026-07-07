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

/** Safety-net cleanup for children a test failed to kill itself. */
const activeChildren = new Set<ChildProcess>();
const tmpDirs = new Set<string>();

function spawnDaemon(dir: string, port: number): Promise<ChildProcess> {
  const child = fork(CHILD_SCRIPT, [dir, String(port)], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  activeChildren.add(child);
  child.once("exit", () => activeChildren.delete(child));
  return new Promise((resolve, reject) => {
    child.once("message", () => resolve(child));
    child.once("exit", (code, signal) => reject(new Error(`daemon child exited early (code=${code}, signal=${signal})`)));
  });
}

function killDaemon(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.add(dir);
  return dir;
}

/** Connects a fresh shim + fake IDE client pair to the given daemon URL. */
async function connectShimClient(daemonUrl: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const shim = createShim(daemonUrl);
  await shim.connect(serverSide);
  const client = new Client({ name: "test-ide", version: "1.0" });
  await client.connect(clientSide);
  return client;
}

after(() => {
  for (const child of activeChildren) child.kill("SIGKILL");
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

test(
  "shim survives a daemon crash and recovers once a fresh daemon is reachable",
  { timeout: 60_000 },
  async () => {
    const dir = tmpDir("brain-daemon-shim-");
    const port = 18961;
    let daemonChild = await spawnDaemon(dir, port);

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const shim = createShim(`http://127.0.0.1:${port}/mcp`);
    await shim.connect(serverSide);

    const ideClient = new Client({ name: "test-ide", version: "1.0" });
    let ideClientClosed = false;
    clientSide.onclose = () => {
      ideClientClosed = true;
    };
    await ideClient.connect(clientSide);

    const r1 = await ideClient.callTool({ name: "remember_knowledge", arguments: { title: "before", content: "daemon is up" } });
    assert.equal(r1.isError, undefined, "call succeeds while the daemon is up");

    await killDaemon(daemonChild);
    await new Promise((r) => setTimeout(r, 300));

    // The core guarantee: the local (IDE-facing) transport must still be open,
    // and the failed call must come back as a normal tool result, not a thrown
    // error or a torn-down connection.
    const r2 = await ideClient.callTool({ name: "remember_knowledge", arguments: { title: "during", content: "daemon is down" } });
    assert.equal(r2.isError, true, "call surfaces as a clean tool error while the daemon is down");
    assert.equal(ideClientClosed, false, "the shim's client-facing transport never closes because the daemon died");

    daemonChild = await spawnDaemon(dir, port);
    const r3 = await ideClient.callTool({ name: "remember_knowledge", arguments: { title: "after", content: "daemon is back" } });
    assert.equal(r3.isError, undefined, "the same shim/client reconnects transparently once the daemon is reachable again");

    await killDaemon(daemonChild);
  },
);

test(
  "one daemon serves multiple concurrent client sessions against the same shared store",
  { timeout: 60_000 },
  async () => {
    const dir = tmpDir("brain-daemon-multi-");
    const port = 18962;
    const daemonChild = await spawnDaemon(dir, port);
    const daemonUrl = `http://127.0.0.1:${port}/mcp`;

    try {
      // Three independent "IDE clients" (own shim, own InMemoryTransport pair,
      // own MCP session against the daemon) — the whole point of the daemon
      // is that these never contend on a cross-process lock the way three
      // separate `dist/mcp/server.js` processes would.
      const [clientA, clientB, clientC] = await Promise.all([
        connectShimClient(daemonUrl),
        connectShimClient(daemonUrl),
        connectShimClient(daemonUrl),
      ]);

      const writes = await Promise.all([
        clientA.callTool({ name: "remember_knowledge", arguments: { title: "multi-A", content: "written by client A" } }),
        clientB.callTool({ name: "remember_knowledge", arguments: { title: "multi-B", content: "written by client B" } }),
        clientC.callTool({ name: "remember_knowledge", arguments: { title: "multi-C", content: "written by client C" } }),
      ]);
      for (const [i, r] of writes.entries()) {
        assert.equal(r.isError, undefined, `concurrent write from client ${i} succeeds`);
      }

      // All three sessions must be visible through the SAME shared MemoryGate —
      // read back client B's write through client C's (different) session to
      // prove it's one store, not three isolated ones.
      const searchResult = await clientC.callTool({ name: "memory_search", arguments: { query: "written by client B", limit: 5 } });
      const text = (searchResult.content as Array<{ text?: string }>)[0]?.text ?? "";
      assert.match(text, /multi-B/, "a write from one session is visible from another session's search");
    } finally {
      await killDaemon(daemonChild);
    }
  },
);
