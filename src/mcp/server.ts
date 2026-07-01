import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Memory } from "../core.js";
import { learn } from "../learning/extractor.js";

/** Idle window after the last call before the DB handle (and lockfile) is released. */
const MCP_IDLE_MS = Math.max(0, Number(process.env.BRAIN_MCP_IDLE_MS) || 3_000);

/**
 * Holds a single {@link Memory} open across tool calls and serializes access to
 * it, releasing the underlying Kuzu handle + cross-process lock only after the
 * server has been idle for {@link MCP_IDLE_MS}.
 *
 * Why not open/close per call: Kuzu's native close can `abort()` the process
 * (uncatchable in JS), so doing it on every request was the main cause of the
 * MCP server dropping its connection. Why not hold it open forever: the prompt
 * hooks and the `brain` CLI are separate processes that need the single-writer
 * lock, so we hand it back once the session goes quiet.
 *
 * All work (open, run, idle-release) runs on one promise chain, so the handle is
 * never disposed while a call is in flight and concurrent calls never race on
 * the single Kuzu connection.
 */
export class MemoryGate {
  private memory: Memory | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param opener how to open the Memory (production: `() => Memory.open(projectPath)`)
   * @param idleMs idle window before the handle + lock are released
   */
  constructor(
    private readonly opener: () => Promise<Memory>,
    private readonly idleMs: number = MCP_IDLE_MS,
  ) {}

  run<T>(fn: (m: Memory) => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      this.cancelIdle();
      const memory = this.memory ?? (this.memory = await this.opener());
      try {
        return await fn(memory);
      } finally {
        this.scheduleIdle();
      }
    });
    // Keep the chain alive (and swallow its settlement) so one failing call
    // never breaks serialization for the next one. Callers still see `result`.
    this.chain = result.then(() => undefined, () => undefined);
    return result as Promise<T>;
  }

  private scheduleIdle(): void {
    this.cancelIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // Release on the chain so we never dispose mid-call.
      this.chain = this.chain.then(() => this.release(), () => this.release());
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private cancelIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Release the handle + lock now, after any in-flight call settles. */
  async close(): Promise<void> {
    this.cancelIdle();
    const done = this.chain.then(() => this.release(), () => this.release());
    this.chain = done.then(() => undefined, () => undefined);
    await done;
  }

  private release(): void {
    const memory = this.memory;
    this.memory = null;
    try {
      memory?.dispose();
    } catch {
      // Native teardown may throw; the lock is released inside dispose() regardless.
    }
  }
}

/**
 * Keep the long-lived MCP server alive on stray errors. A single unhandled
 * rejection would otherwise terminate the process (Node default) and drop the
 * stdio connection. Diagnostics go to stderr — stdout is reserved for JSON-RPC.
 */
let guardsInstalled = false;
export function installProcessGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;
  process.on("uncaughtException", (err) => {
    console.error("the-brain MCP: uncaughtException (kept alive):", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("the-brain MCP: unhandledRejection (kept alive):", reason);
  });
}

/**
 * MCP server — the primary Claude Code integration surface.
 *
 * CRITICAL: stdio transport reserves stdout for JSON-RPC. All diagnostics MUST
 * go to stderr (console.error), never console.log.
 *
 * Concurrency: Kuzu permits only one read-write process per database file, so
 * the server must release the database (and its cross-process lockfile) when it
 * is not actively serving a call — otherwise the prompt hooks and the `brain`
 * CLI (separate processes) fail with a lock error.
 *
 * It must NOT, however, open and close the native Kuzu handle on every single
 * call: Kuzu's native destructors can `abort()` during close (see
 * GraphDB.dispose), and an abort is a hard process termination that no JS
 * try/catch can intercept — repeated per-call teardown was crashing the server
 * and dropping the MCP connection. Instead `MemoryGate` keeps ONE Memory open,
 * serializes calls through it, and releases it only after a short idle window
 * (BRAIN_MCP_IDLE_MS, default 3s). Bursts of tool calls reuse a single handle
 * (no churn), and the lock is still handed back to hooks/CLI when the session
 * goes quiet. `GraphDB.openAt` retries on brief lock contention.
 *
 * Tools:
 *   memory_context · memory_search · memory_component        (read)
 *   remember_decision · remember_experience · remember_review_finding
 *   remember_knowledge · remember_standard · learn_from_text (write)
 *   ingest_repository · ingest_github                        (write)
 *   curate_memory · consolidate_memory                       (maintenance)
 */
export async function createMcpServer(projectPath?: string): Promise<McpServer> {
  const server = new McpServer(
    { name: "the-brain", version: "0.1.0" },
    {
      instructions:
        "Persistent project memory. Call memory_context at the start of a task to load " +
        "relevant decisions, review findings, standards and experiences. Use the remember_* " +
        "tools to persist new knowledge so future sessions benefit.",
    },
  );

  const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

  // Serialize every tool call through a single, idle-released Memory handle.
  const gate = new MemoryGate(() => Memory.open(projectPath));
  const withMemory = <T>(fn: (m: Memory) => Promise<T>): Promise<T> => gate.run(fn);

  server.registerTool(
    "memory_context",
    {
      title: "Load project memory context",
      description: "Return prioritized, deduplicated project memory (review findings, standards, decisions, architecture, experiences, knowledge) relevant to a task description. Call this before starting work.",
      inputSchema: { query: z.string().describe("The task or prompt to retrieve context for"), limit: z.number().optional() },
    },
    async ({ query, limit }) =>
      withMemory(async (memory) => {
        const ctx = await memory.context(query, limit ?? 30);
        return text(ctx.markdown || ctx.summary);
      }),
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search project memory",
      description: "Semantic + graph search over project memory. Returns ranked nodes with scores.",
      inputSchema: { query: z.string(), limit: z.number().optional() },
    },
    async ({ query, limit }) =>
      withMemory(async (memory) => {
        const hits = await memory.search(query, limit ?? 20);
        return text(hits.map((h) => ({ label: h.label, id: h.id, score: Number(h.score.toFixed(3)), ...h.props, embedding: undefined })));
      }),
  );

  server.registerTool(
    "memory_component",
    {
      title: "Look up a component",
      description: "Return decisions, dependencies, review findings and experiences related to a named component.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => withMemory(async (memory) => text(await memory.component(name))),
  );

  server.registerTool(
    "remember_decision",
    {
      title: "Remember an architecture decision (ADR)",
      description: "Persist an architecture decision so it is never lost.",
      inputSchema: {
        title: z.string(),
        decision: z.string(),
        problem: z.string().optional(),
        reasoning: z.string().optional(),
        alternatives: z.string().optional(),
      },
    },
    async (args) =>
      withMemory(async (memory) => text(await memory.repo.upsertNode("Decision", { ...args, date: new Date().toISOString().slice(0, 10) }))),
  );

  server.registerTool(
    "remember_experience",
    {
      title: "Remember a learned experience",
      description: "Persist a problem→solution experience for reuse.",
      inputSchema: { problem: z.string(), solution: z.string(), outcome: z.string().optional(), confidence: z.number().optional() },
    },
    async (args) => withMemory(async (memory) => text(await memory.repo.upsertNode("Experience", args))),
  );

  server.registerTool(
    "remember_review_finding",
    {
      title: "Remember a code review finding",
      description: "Persist a review finding so the same mistake is not repeated. These get highest retrieval priority.",
      inputSchema: {
        rule: z.string(),
        severity: z.string().optional(),
        category: z.string().optional(),
        example: z.string().optional(),
        fix: z.string().optional(),
      },
    },
    async (args) => withMemory(async (memory) => text(await memory.repo.upsertNode("ReviewFinding", { frequency: 1, ...args }))),
  );

  server.registerTool(
    "remember_knowledge",
    {
      title: "Remember general project knowledge",
      description: "Persist general project knowledge.",
      inputSchema: { title: z.string(), content: z.string(), tags: z.array(z.string()).optional(), importance: z.number().optional() },
    },
    async (args) => withMemory(async (memory) => text(await memory.repo.upsertNode("Knowledge", args))),
  );

  server.registerTool(
    "remember_standard",
    {
      title: "Remember a coding standard",
      description: "Persist a project coding standard / rule.",
      inputSchema: { name: z.string(), description: z.string(), examples: z.string().optional() },
    },
    async (args) => withMemory(async (memory) => text(await memory.repo.upsertNode("CodingStandard", args))),
  );

  server.registerTool(
    "ingest_github",
    {
      title: "Ingest GitHub issues & PRs",
      description: "Pull GitHub issues (→ Problem nodes) and pull requests (→ Decision nodes) via the gh CLI, and link commits that reference a PR. Requires gh to be installed and authenticated.",
      inputSchema: { limit: z.number().optional().describe("Max issues/PRs to fetch (default 100)") },
    },
    async ({ limit }) =>
      withMemory(async (memory) => {
        const { ingestGitHub } = await import("../github.js");
        return text(await ingestGitHub(memory, { limit, cwd: projectPath }));
      }),
  );

  server.registerTool(
    "ingest_repository",
    {
      title: "Ingest repository structure",
      description: "Scan the project's git work tree into the graph: Project, Directory and File nodes with CONTAINS edges, plus recent GitCommit nodes with MODIFIES edges. Run once per project and after large changes.",
      inputSchema: { gitLimit: z.number().optional().describe("How many recent commits to ingest (default 100)") },
    },
    async ({ gitLimit }) =>
      withMemory(async (memory) => {
        const { ingest } = await import("../ingest/index.js");
        return text(await ingest(memory, projectPath, gitLimit ?? 100));
      }),
  );

  server.registerTool(
    "curate_memory",
    {
      title: "Curate the knowledge graph",
      description: "Run the maintenance agent: consolidate duplicates, promote recurring review findings into coding standards, and (optionally) prune stale low-value knowledge. Use dryRun to preview.",
      inputSchema: {
        dryRun: z.boolean().optional(),
        prune: z.boolean().optional().describe("Also delete stale, unused, low-importance knowledge"),
      },
    },
    async ({ dryRun, prune }) =>
      withMemory(async (memory) => {
        const { curate } = await import("../curate.js");
        return text(await curate(memory, { dryRun, prune }));
      }),
  );

  server.registerTool(
    "consolidate_memory",
    {
      title: "Consolidate duplicate knowledge",
      description: "Merge semantically duplicate knowledge nodes (same type, cosine ≥ threshold): keep one canonical node, rewire its relationships, accumulate usage/frequency, delete the rest. Use dryRun first to preview.",
      inputSchema: {
        threshold: z.number().optional().describe("Cosine similarity to treat as duplicate (default 0.95)"),
        dryRun: z.boolean().optional().describe("Preview without modifying the graph"),
      },
    },
    async ({ threshold, dryRun }) =>
      withMemory(async (memory) => {
        const { consolidate } = await import("../consolidate.js");
        return text(await consolidate(memory, { threshold, dryRun }));
      }),
  );

  server.registerTool(
    "learn_from_text",
    {
      title: "Extract and store knowledge from text",
      description: "Scan free text for ADR/FINDING/LEARNED/RULE/NOTE markers and persist any found. Use on review summaries or notes.",
      inputSchema: { text: z.string() },
    },
    async ({ text: t }) =>
      withMemory(async (memory) => {
        const { isLLMEnabled } = await import("../llm.js");
        return text(await learn(memory, t, { useLLM: isLLMEnabled() }));
      }),
  );

  return server;
}

// Entry point: `tsx src/mcp/server.ts` / `npm run mcp` / brain mcp
if (import.meta.url === `file://${process.argv[1]}`) {
  installProcessGuards();
  createMcpServer()
    .then(async (server) => {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error("🧠 the-brain MCP server running on stdio");
    })
    .catch((err) => {
      console.error("Failed to start MCP server:", err);
      process.exit(1);
    });
}
