# AGENTS.md — the_brain

A Kuzu-backed persistent memory plugin for Claude Code. Everything is local.

## Commands

```bash
npm run build        # tsc → dist/ (required before hooks/MCP work)
npm test             # custom runner: test/run.mjs
npm run brain        # CLI via tsx, no build needed
npm run mcp          # MCP stdio server via tsx (dev)
npm run serve        # GraphQL server via tsx (dev)
node --import tsx --test --test-reporter=spec test/core.test.ts   # single test
```

`npm test` sets `BRAIN_FAKE_EMBED=1` automatically — tests use deterministic hashing, not ONNX. To test real embeddings: `BRAIN_FAKE_EMBED= npm test`.

No `lint` or `typecheck` scripts — `npm run build` runs `tsc` and catches type errors.

**Test runner quirk:** `test/run.mjs` is custom because native `onnxruntime`/Kuzu destructors crash on exit after tests pass. The runner parses subtest output directly — a file only fails on a named subtest failure or mid-run crash. Don't replace with `node --test`.

## Architecture

One facade to rule them all — `Memory` in `src/core.ts`. Every entrypoint (MCP tools, GraphQL resolvers, CLI commands, hooks) constructs a `Memory` via `Memory.open(projectPath?)` or `Memory.openAt(storageDir)`. This ensures consistent retrieval and learning behavior.

Entrypoints (all require `npm run build` first):
- **Hooks** — `dist/hooks/inject.js` (`UserPromptSubmit`), `dist/hooks/learn.js` (`Stop`)
- **MCP** — `dist/mcp/server.js` (stdio, registered in `.mcp.json`)
- **CLI** — `dist/bin/brain.js` (also runnable via `npm run brain` → tsx)

## Hard constraints

1. **Kuzu single-writer** — only one process at a time per DB. The advisory lockfile (`.brain.lock`) serializes MCP server, hooks, and CLI. The MCP server opens DB, runs tool, disposes DB — never holds it open between calls. Don't hold a `GraphDB` instance across async waits without understanding lock implications.

2. **MCP stdout is reserved for JSON-RPC** — any `console.log` in `src/mcp/server.ts` or hooks corrupts the protocol. All diagnostics must go to `console.error`.

3. **Stable IDs** — knowledge node IDs are deterministic content hashes, making `learn` idempotent and letting recurring findings accumulate a `frequency` counter.

4. **No HNSW vector index** — intentionally omitted. Cosine scan is fast enough at current scale (~82 ms median for ~100k nodes). HNSW would make writes ~10× slower.

## Key env vars

| Variable | Default | When to set |
|---|---|---|
| `BRAIN_HOME` | `~/.claude-memory` | custom root storage dir |
| `BRAIN_PROJECT_LOCAL` | — | `1` → store in `./.project-memory/` |
| `BRAIN_FAKE_EMBED` | — | `1` → deterministic hash (CI/tests) |
| `BRAIN_OFFLINE` | — | `1` → forbid model downloads (after cached) |
| `BRAIN_LLM_URL` | — | local OpenAI endpoint for LLM extraction |
| `BRAIN_TOKEN_BUDGET` | `1500` | max context tokens per prompt |
| `BRAIN_GRAPHQL_PORT` | `4123` | GraphQL server port |
| `BRAIN_BACKUP_KEY` | — | passphrase for encrypted backups |
| `BRAIN_LOCK_TIMEOUT` | `10000` | max ms to wait for the lock before throwing |
| `BRAIN_LOCK_STALE_MS` | `15000` | mtime age after which a stale lockfile is broken |

## Loading the plugin in Claude Code

```bash
claude --plugin-dir /absolute/path/to/the-brain
```

Or permanently: copy the two hook files + `.mcp.json` into your project. See `INSTALL.md`.

## See also

`CLAUDE.md` — full architecture, schema details, retrieval formulas, and all 14 MCP tools. Read it before making significant changes.
