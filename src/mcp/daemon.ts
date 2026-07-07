import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Memory } from "../core.js";
import { MemoryGate, registerTools, installProcessGuards } from "./server.js";

const DEFAULT_PORT = Number(process.env.BRAIN_DAEMON_PORT) || 8934;
const HOST = "127.0.0.1";

/**
 * Single, shared MCP server for a project's store, reachable over HTTP so
 * every local MCP client (Claude Code, OpenCode, ...) can point at ONE
 * process instead of each spawning its own `dist/mcp/server.js` — which is
 * what forces them to cooperate over the cross-process `.brain.lock` (see
 * KNOWN_ISSUES.md). With one daemon there is only ever one Kuzu handle for
 * this store, full stop: no lock-wait latency between client processes, and
 * a crash only tears down the daemon, not any individual client's own
 * connection to it (see shim.ts for the client-side half of that guarantee).
 *
 * Session model: MCP's Streamable HTTP transport is stateful — a client's
 * `initialize` call gets a session ID, and every later call on that
 * connection carries it back in the `mcp-session-id` header. Each session
 * gets its own lightweight McpServer + transport (created fresh here), but
 * all of them share the ONE MemoryGate constructed below, so tool calls
 * across every connected client still serialize onto a single Kuzu handle
 * exactly like the stdio server does for calls within one process.
 *
 * Deliberately out of scope for this prototype: GET (server-initiated SSE
 * push) and DELETE (explicit session close) handling. the-brain's tools are
 * plain request/response with no server-initiated notifications, so
 * `enableJsonResponse: true` disables SSE entirely; sessions are just left to
 * live for the daemon process's lifetime (expected to be a service-managed,
 * long-lived process — see the launchd/systemd unit examples in DEVELOPER.md).
 */
export async function startDaemon(
  projectPath?: string,
  port: number = DEFAULT_PORT,
): Promise<{ url: string; close: () => Promise<void> }> {
  const gate = new MemoryGate(() => Memory.open(projectPath));
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  async function newSession(): Promise<StreamableHTTPServerTransport> {
    const server = new McpServer({ name: "the-brain-daemon", version: "0.1.0" });
    registerTools(server, gate, projectPath);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, transport);
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return transport;
  }

  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res, body);
      return;
    }
    if (typeof sessionId === "string") {
      // A session ID was presented but we don't hold it — either it never
      // existed here or the daemon restarted since. Per the transport's own
      // contract this is a 404, which is exactly the signal shim.ts's client
      // needs to know "reconnect and re-initialize" instead of retrying blind.
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
      return;
    }
    if (!isInitializeRequest(body)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no session, not an initialize request" }, id: null }));
      return;
    }
    const transport = await newSession();
    await transport.handleRequest(req, res, body);
  }

  const httpServer = createHttpServer((req, res) => {
    if (req.method !== "POST" || !req.url || new URL(req.url, "http://internal").pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    readJsonBody(req)
      .then((body) => handleMcpRequest(req, res, body))
      .catch((err) => {
        console.error("the-brain daemon: request failed:", err);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end();
      });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, HOST, resolve);
  });
  const url = `http://${HOST}:${port}/mcp`;
  console.error(`🧠 the-brain daemon listening on ${url}`);

  return {
    url,
    close: async () => {
      await new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
      await gate.close();
    },
  };
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Entry point: `tsx src/mcp/daemon.ts` / `node dist/mcp/daemon.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  installProcessGuards();
  startDaemon().catch((err) => {
    console.error("Failed to start the-brain daemon:", err);
    process.exit(1);
  });
}
