import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Memory } from "../core.js";
import { learn } from "../learning/extractor.js";

/**
 * MCP server — the primary Claude Code integration surface.
 *
 * CRITICAL: stdio transport reserves stdout for JSON-RPC. All diagnostics MUST
 * go to stderr (console.error), never console.log.
 *
 * Tools:
 *   memory_context        — assembled, prioritized context for a prompt (read)
 *   memory_search         — ranked raw hits (read)
 *   memory_component      — component-centric view (read)
 *   remember_decision     — persist an ADR (write)
 *   remember_experience   — persist a learned experience (write)
 *   remember_review_finding — persist a review finding (write)
 *   remember_knowledge    — persist general knowledge (write)
 *   remember_standard     — persist a coding standard (write)
 *   learn_from_text       — run the heuristic extractor over free text (write)
 */
export async function createMcpServer(projectPath?: string): Promise<McpServer> {
  const memory = await Memory.open(projectPath);
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

  server.registerTool(
    "memory_context",
    {
      title: "Load project memory context",
      description: "Return prioritized, deduplicated project memory (review findings, standards, decisions, architecture, experiences, knowledge) relevant to a task description. Call this before starting work.",
      inputSchema: { query: z.string().describe("The task or prompt to retrieve context for"), limit: z.number().optional() },
    },
    async ({ query, limit }) => {
      const ctx = await memory.context(query, limit ?? 30);
      return text(ctx.markdown || ctx.summary);
    },
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search project memory",
      description: "Semantic + graph search over project memory. Returns ranked nodes with scores.",
      inputSchema: { query: z.string(), limit: z.number().optional() },
    },
    async ({ query, limit }) => {
      const hits = await memory.search(query, limit ?? 20);
      return text(hits.map((h) => ({ label: h.label, id: h.id, score: Number(h.score.toFixed(3)), ...h.props, embedding: undefined })));
    },
  );

  server.registerTool(
    "memory_component",
    {
      title: "Look up a component",
      description: "Return decisions, dependencies, review findings and experiences related to a named component.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => text(await memory.component(name)),
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
    async (args) => text(await memory.repo.upsertNode("Decision", { ...args, date: new Date().toISOString().slice(0, 10) })),
  );

  server.registerTool(
    "remember_experience",
    {
      title: "Remember a learned experience",
      description: "Persist a problem→solution experience for reuse.",
      inputSchema: { problem: z.string(), solution: z.string(), outcome: z.string().optional(), confidence: z.number().optional() },
    },
    async (args) => text(await memory.repo.upsertNode("Experience", args)),
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
    async (args) => text(await memory.repo.upsertNode("ReviewFinding", { frequency: 1, ...args })),
  );

  server.registerTool(
    "remember_knowledge",
    {
      title: "Remember general project knowledge",
      description: "Persist general project knowledge.",
      inputSchema: { title: z.string(), content: z.string(), tags: z.array(z.string()).optional(), importance: z.number().optional() },
    },
    async (args) => text(await memory.repo.upsertNode("Knowledge", args)),
  );

  server.registerTool(
    "remember_standard",
    {
      title: "Remember a coding standard",
      description: "Persist a project coding standard / rule.",
      inputSchema: { name: z.string(), description: z.string(), examples: z.string().optional() },
    },
    async (args) => text(await memory.repo.upsertNode("CodingStandard", args)),
  );

  server.registerTool(
    "ingest_repository",
    {
      title: "Ingest repository structure",
      description: "Scan the project's git work tree into the graph: Project, Directory and File nodes with CONTAINS edges, plus recent GitCommit nodes with MODIFIES edges. Run once per project and after large changes.",
      inputSchema: { gitLimit: z.number().optional().describe("How many recent commits to ingest (default 100)") },
    },
    async ({ gitLimit }) => {
      const { ingest } = await import("../ingest/index.js");
      const res = await ingest(memory, projectPath, gitLimit ?? 100);
      return text(res);
    },
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
    async ({ threshold, dryRun }) => {
      const { consolidate } = await import("../consolidate.js");
      return text(await consolidate(memory, { threshold, dryRun }));
    },
  );

  server.registerTool(
    "learn_from_text",
    {
      title: "Extract and store knowledge from text",
      description: "Scan free text for ADR/FINDING/LEARNED/RULE/NOTE markers and persist any found. Use on review summaries or notes.",
      inputSchema: { text: z.string() },
    },
    async ({ text: t }) => text(await learn(memory, t)),
  );

  return server;
}

// Entry point: `tsx src/mcp/server.ts` / `npm run mcp` / brain mcp
if (import.meta.url === `file://${process.argv[1]}`) {
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
