# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install deps (triggers postinstall scripts for kuzu, onnxruntime, etc.)
npm run build        # compile TypeScript → dist/  (required before using CLI or hooks)
npm test             # run all tests (see note below)
npm run brain        # run CLI via tsx (dev mode, no build needed)
```

**Single test file:**
```bash
node --import tsx --test --test-reporter=spec test/core.test.ts
```

**Test environment note:** `npm test` sets `BRAIN_FAKE_EMBED=1` by default — tests use deterministic hashing instead of the real ONNX embedding model for stability. To run with the real embedder, set `BRAIN_FAKE_EMBED=` (empty) before running the embedder test.

**Why the test runner (`test/run.mjs`) is custom:** native `onnxruntime`/Kuzu destructors sometimes crash at process exit after tests pass, making the exit code unreliable. The runner parses subtest results directly and only marks a file failed on a named subtest failure or a mid-run crash with no summary.

**CLI (after build):**
```bash
node dist/bin/brain.js ingest          # scan repo structure + git history
node dist/bin/brain.js query "…"       # print context block
node dist/bin/brain.js learn "…"       # store a knowledge marker
node dist/bin/brain.js explore out.html  # interactive graph
node dist/bin/brain.js curate          # deduplicate + promote findings
```

## Architecture

```
Claude Code
   │  UserPromptSubmit hook        │  MCP (stdio)            │  GraphQL (HTTP)
   ▼  src/hooks/inject.ts          ▼  src/mcp/server.ts      ▼  src/graphql/server.ts
   └──────────────────── Memory facade (src/core.ts) ───────────────────┘
                                   │
        retrieval (search · ranking · contextBuilder) · learning (extractor)
                                   │
              embeddings (bge-small, local ONNX) · Repository · GraphDB
                                   │
                    Kuzu graph DB @ ~/.claude-memory/<project>/
```

**`src/core.ts` — `Memory` class** is the single facade all interfaces use. Construct with `Memory.open(projectPath?)` or `Memory.openAt(storageDir)`. Every MCP tool, GraphQL resolver, and CLI command goes through this to ensure consistent behavior.

**`src/db/`**
- `kuzu.ts` — thin async wrapper over the Kuzu embedded graph DB. Handles schema init, migrations, checkpointing, and lock-acquisition retries.
- `lock.ts` — cross-process advisory lockfile (`.brain.lock`). Kuzu is single-writer; the MCP server, hooks, and CLI are separate OS processes, so they serialize through this cooperative lock. Same-process re-entry is reference-counted to avoid self-deadlock.
- `repo.ts` — CRUD layer (upsert nodes by stable ID, bump usage counts).
- `schema.ts` — single source of truth for all DDL: 11 node types (`Project`, `Component`, `File`, `Directory`, `GitCommit`, `Knowledge`, `Decision`, `Experience`, `ReviewFinding`, `CodingStandard`, `Problem`) and 12 relationship types. `REL_DEFS` drives both DDL generation and edge-rewiring during consolidation.

**`src/embeddings/embedder.ts`** — local ONNX embeddings via `@huggingface/transformers`, model `bge-small-en-v1.5` (384-dimensional). Downloaded once to `~/.claude-memory/models/`. Set `BRAIN_FAKE_EMBED=1` for tests/CI. Set `BRAIN_OFFLINE=1` to forbid downloads once cached.

**`src/retrieval/`**
- `search.ts` — semantic search using `array_cosine_similarity` directly in Kuzu, then graph-traversal expansion.
- `ranking.ts` — combined score: `0.40·semantic + 0.25·graph + 0.15·importance + 0.10·usage + 0.10·recency`.
- `contextBuilder.ts` — deduplicates, enforces priority order (ReviewFindings → CodingStandards → Decisions → Architecture → Experiences → Knowledge), summarizes, and stays within a token budget (`BRAIN_TOKEN_BUDGET`, default 1500).
- `intent.ts` — classifies the query to weight retrieval toward the right node types.

**`src/learning/extractor.ts`** — parses knowledge markers (`DECISION:`, `FINDING[sev]:`, `LEARNED:`, `RULE:`, `NOTE:`) from text. With `BRAIN_LLM_URL` set, also queries a local OpenAI-compatible endpoint to extract unmarked knowledge; results are merged via stable ID deduplication. Marker extraction is always deterministic; LLM is additive-only.

**`src/mcp/server.ts`** — MCP stdio server (14 tools). **Critical:** stdout is reserved for JSON-RPC; all diagnostics must go to `stderr`. Each tool opens the DB via `withMemory`, runs, then disposes (releases the lock) before returning — the server never holds the DB open between calls.

**`src/hooks/`**
- `inject.ts` — `UserPromptSubmit` hook; prepends relevant memory context to every prompt.
- `learn.ts` — `Stop` hook; extracts knowledge from the last assistant turn and persists it.

**`src/graphql/`** — GraphQL API on `127.0.0.1:4123` (port `BRAIN_GRAPHQL_PORT`). Primarily for tooling/debugging; the primary integration paths are MCP and the prompt hook.

## Key design constraints

**Kuzu single-writer:** Kuzu only allows one read-write process per database file at a time. The advisory lockfile in `src/db/lock.ts` serializes the MCP server, hooks, and CLI. Do not attempt to hold a `GraphDB` instance open across async waits in long-lived processes without understanding the lock implications — the MCP server explicitly disposes the DB after every tool call for this reason.

**MCP stdout:** the stdio transport uses stdout exclusively for JSON-RPC. Any `console.log` in MCP server code will corrupt the protocol. Use `console.error` for all diagnostics in `src/mcp/server.ts` and the hooks.

**Stable IDs:** knowledge node IDs are derived deterministically from content (e.g., a hash of rule + severity for `ReviewFinding`). This makes `learn` idempotent and lets recurring findings accumulate a `frequency` counter instead of creating duplicates.

**No HNSW index:** the native Kuzu HNSW vector index is intentionally omitted. At the current scale (~100k nodes) the in-DB cosine scan is fast enough (~82 ms median) and HNSW would make writes ~10× slower due to index maintenance.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `BRAIN_HOME` | `~/.claude-memory` | root storage directory |
| `BRAIN_PROJECT_LOCAL` | — | `1` → store in `./.project-memory/` |
| `BRAIN_TOKEN_BUDGET` | `1500` | context block token budget |
| `BRAIN_OFFLINE` | — | `1` → forbid embedding model downloads |
| `BRAIN_FAKE_EMBED` | — | `1` → deterministic hash embeddings (tests) |
| `BRAIN_LLM_URL` | — | local OpenAI-compatible endpoint for extraction |
| `BRAIN_LLM_MODEL` | `llama3.2` | model name |
| `BRAIN_BACKUP_KEY` | — | passphrase for AES-256-GCM backup encryption |
| `BRAIN_GRAPHQL_PORT` | `4123` | GraphQL server port |
| `BRAIN_MAX_DB_SIZE` | `4 GiB` | Kuzu mmap reservation cap per store |

## Plugin wiring

The repo is a Claude Code plugin. The manifest is in `.claude-plugin/plugin.json`. Hooks are declared in `hooks/hooks.json` (two hooks: `UserPromptSubmit` → `dist/hooks/inject.js`, `Stop` → `dist/hooks/learn.js`). The MCP server is registered in `.mcp.json`. All three entrypoints require `npm run build` to exist.
