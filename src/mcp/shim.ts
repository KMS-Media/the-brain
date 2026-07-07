import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { installProcessGuards } from "./server.js";

const DEFAULT_DAEMON_URL = process.env.BRAIN_DAEMON_URL ?? `http://127.0.0.1:${process.env.BRAIN_DAEMON_PORT ?? 8934}/mcp`;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Client-side half of the daemon/shim split (see daemon.ts). Owns the
 * connection to the shared daemon and hides its failure modes from the shim's
 * own MCP server below: a daemon crash, restart, or transient network error
 * surfaces here as a retryable exception, never as a closed connection on the
 * client-facing side.
 *
 * Reconnection covers both cases that matter: (1) a stale HTTP connection
 * (daemon still up, socket dropped) and (2) the daemon process having
 * restarted entirely, which invalidates every session ID it was holding —
 * the daemon returns 404 for those, which `Client.callTool` surfaces as a
 * rejected promise, and `invalidate()` here just throws the whole client
 * away so the next attempt re-initializes a fresh session from scratch.
 */
class DaemonProxy {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(private readonly daemonUrl: string) {}

  private async connect(): Promise<Client> {
    const client = new Client({ name: "the-brain-shim", version: "0.2.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.daemonUrl));
    await client.connect(transport);
    return client;
  }

  private ensureClient(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.connecting) {
      this.connecting = this.connect().then(
        (c) => {
          this.client = c;
          this.connecting = null;
          return c;
        },
        (err) => {
          this.connecting = null;
          throw err;
        },
      );
    }
    return this.connecting;
  }

  private invalidate(): void {
    this.client = null;
  }

  private async withRetry<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      try {
        const client = await this.ensureClient();
        return await fn(client);
      } catch (err) {
        lastErr = err;
        this.invalidate();
        if (attempt < RETRY_ATTEMPTS - 1) await sleep(RETRY_BASE_MS * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  listTools() {
    return this.withRetry((client) => client.listTools());
  }

  callTool(name: string, args: unknown) {
    return this.withRetry((client) => client.callTool({ name, arguments: args as Record<string, unknown> | undefined }));
  }
}

/**
 * Build the shim's client-facing MCP server: a thin, tool-schema-agnostic
 * proxy in front of a single shared daemon (see daemon.ts). This is what each
 * local MCP client config (`.mcp.json`) should launch instead of
 * `dist/mcp/server.js` directly, once a daemon is running for the project.
 *
 * The low-level `Server` (not `McpServer`) is used deliberately: it lets
 * `tools/list` and `tools/call` be forwarded verbatim (JSON Schema as given
 * by the daemon, no Zod re-derivation), so the shim never needs updating when
 * the daemon's tool set changes.
 *
 * Failure containment is the entire point of this file: if the daemon is
 * unreachable, `tools/call` resolves with a normal `isError` tool result
 * instead of throwing — the local stdio transport to the actual IDE/agent
 * client is never torn down because the daemon had a bad moment.
 */
export function createShim(daemonUrl: string = DEFAULT_DAEMON_URL): Server {
  const server = new Server({ name: "the-brain", version: "0.2.0" }, { capabilities: { tools: {} } });
  const proxy = new DaemonProxy(daemonUrl);

  server.setRequestHandler(ListToolsRequestSchema, () => proxy.listTools());

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await proxy.callTool(request.params.name, request.params.arguments);
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `the-brain daemon unreachable (${daemonUrl}): ${String((err as Error)?.message ?? err)}` }],
        isError: true,
      };
    }
  });

  return server;
}

// Entry point: `tsx src/mcp/shim.ts` / `node dist/mcp/shim.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  installProcessGuards();
  const server = createShim();
  server
    .connect(new StdioServerTransport())
    .then(() => console.error(`🧠 the-brain shim running on stdio -> ${DEFAULT_DAEMON_URL}`))
    .catch((err) => {
      console.error("Failed to start the-brain shim:", err);
      process.exit(1);
    });
}
