# 🧠 the_brain — Workflow & How It Works

How the plugin operates day-to-day, how it captures new knowledge, and how to
connect a local LLM. For installation see [INSTALL.md](./INSTALL.md); for
architecture and internals see [DEVELOPER.md](./DEVELOPER.md).

---

## 1. How the plugin works

the_brain hooks into two points of the Claude Code flow and additionally
exposes tools that Claude itself can call.

```
            YOU submit a prompt
                     │
   ┌─────────────────▼──────────────────┐
   │ UserPromptSubmit Hook               │  (hooks/inject.js)
   │  → relevant knowledge is prepended  │
   │    before your prompt               │
   └─────────────────┬──────────────────┘
                     ▼
            Claude answers
                     │
   ┌─────────────────▼──────────────────┐
   │ Stop Hook                           │  (hooks/learn.js)
   │  → learns from the answer           │
   └─────────────────────────────────────┘

   In parallel: Claude can call the MCP tools at any time
   (memory_context, memory_search, remember_*, …)
```

### Retrieval before every prompt

On every prompt the `UserPromptSubmit` hook fires and injects relevant project
knowledge. Internally the retrieval pipeline works like this:

1. **Intent analysis** — the prompt is loosely classified (is this about review
   findings? architecture? standards? …). Matching knowledge types receive higher
   weight.
2. **Embedding** — the prompt is encoded into a vector locally.
3. **Semantic search** — similar knowledge nodes are found via cosine similarity
   directly inside the graph DB.
4. **Graph traversal** — connected nodes (e.g. the decision linked to a found
   component) are pulled in.
5. **Ranking** — combined score:
   `0.40·semantic + 0.25·graph + 0.15·importance + 0.10·usage + 0.10·recency`.
6. **Context builder** — deduplicates, applies priority order (**Review Findings
   → Coding Standards → Decisions → Architecture → Experiences → Knowledge**),
   summarises, and stays within a token budget.

The result is a compact Markdown block that Claude sees before your prompt —
you don't have to do anything.

### Tools Claude can call (MCP)

Via the MCP server Claude has access to, among others:

- **Read:** `memory_context` (compact context for a task),
  `memory_search` (ranked hits), `memory_component` (everything about a
  component).
- **Write:** `remember_decision`, `remember_experience`,
  `remember_review_finding`, `remember_knowledge`, `remember_standard`,
  `learn_from_text`.
- **Maintenance:** `consolidate_memory`, `curate_memory`, `ingest_repository`,
  `ingest_github`.

### Where the data lives

| | Location |
|---|---|
| Knowledge database (per project) | `~/.claude-memory/<project>/` |
| Embedding model cache | `~/.claude-memory/models/` |

Everything stays local — no cloud, no telemetry.

---

## 2. How it captures new knowledge

There are four ways knowledge enters the graph:

### a) Automatically after every answer (Stop Hook)

After each Claude answer the `Stop` hook reads the last response and extracts
structured knowledge. It recognises **marker lines** — whether written by you or
by Claude:

| Marker | Becomes | Example |
|--------|---------|---------|
| `DECISION:` / `ADR:` | Decision | `ADR: Use Kuzu \| embedded graph DB` |
| `FINDING[sev]:` | Review finding | `FINDING[high]: secret in code -> use env` |
| `LEARNED:` | Experience | `LEARNED: flaky test -> raise timeout` |
| `RULE:` | Coding standard | `RULE: validate input \| with zod` |
| `NOTE:` | Knowledge | `NOTE: deploy \| runs on Node LTS` |

Properties:
- **Idempotent:** a stable ID is derived from the content — the same insight
  never creates duplicates.
- **Frequency:** recurring review findings increment their `frequency` counter
  instead of multiplying.
- **Embedding on write:** every knowledge node is embedded immediately and is
  therefore semantically searchable.

### b) Explicitly via the CLI

```bash
node dist/bin/brain.js learn "DECISION: Use PostgreSQL | chosen for JSONB support"
```

### c) Ingesting structure and history

```bash
node dist/bin/brain.js ingest        # files/directories + git history
node dist/bin/brain.js github        # GitHub issues (→ Problem) & PRs (→ Decision)
```

### d) Directly by Claude

Claude can call the `remember_*` tools or `learn_from_text` to store knowledge
explicitly.

### Quality over time (curation)

To keep the memory from becoming noisy, there is a maintenance agent:

```bash
node dist/bin/brain.js curate        # merge duplicates + promote findings → standards + optional pruning
```

It merges semantic duplicates, promotes frequent review findings to coding
standards, and can remove stale, unused knowledge (`--prune`). Run it regularly
— a cron job works well.

---

## 3. Connecting a local LLM

By default the_brain extracts knowledge purely heuristically (the markers above)
— **without** an LLM, fully deterministic. Optionally you can connect a **local**
LLM that improves extraction: it recognises unmarked but reusable knowledge in
Claude's answers and stores it in a structured way. The LLM runs on your machine
— nothing ever leaves your computer.

### Step 1 — Provide a local LLM

The easiest way is [Ollama](https://ollama.com):

```bash
# Install Ollama, then pull a model and start the server:
ollama pull llama3.2
ollama serve          # exposes an OpenAI-compatible API on :11434
```

Any local **OpenAI-compatible** chat endpoint (`/v1/chat/completions`) works —
including llama.cpp.

### Step 2 — Point the_brain to it (environment variables)

| Variable | Purpose | Example |
|----------|---------|---------|
| `BRAIN_LLM_URL` | Base URL of the endpoint (activates LLM usage) | `http://localhost:11434/v1` |
| `BRAIN_LLM_MODEL` | Model name | `llama3.2` |
| `BRAIN_LLM_KEY` | API key if required (usually not needed for Ollama) | — |

If `BRAIN_LLM_URL` is **not** set or the endpoint is unreachable, the_brain
silently falls back to heuristics — it never breaks.

### Step 3 — Giving the plugin access (important)

Hooks and the MCP server run as **subprocesses** started by Claude Code. They
only see environment variables present in **Claude Code's own environment**.
To make **all** learning paths (auto-learn hook, CLI, MCP) use the LLM, export
the variables **before** starting Claude Code:

```bash
# in ~/.zshrc or ~/.bashrc — applies to every Claude Code session
export BRAIN_LLM_URL="http://localhost:11434/v1"
export BRAIN_LLM_MODEL="llama3.2"
```

Open a new shell (or `source ~/.zshrc`), then start Claude Code.

If you want to give the LLM **only** to the MCP server (not the hooks), you can
set the variables in the MCP configuration instead:

```json
{
  "mcpServers": {
    "the-brain": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js"],
      "env": {
        "BRAIN_LLM_URL": "http://localhost:11434/v1",
        "BRAIN_LLM_MODEL": "llama3.2"
      }
    }
  }
}
```

> Recommendation: export via the shell (above) — that way the auto-learn Stop
> Hook also benefits from the LLM, not just the MCP tools.

### Step 4 — Verify the LLM is active

```bash
# With BRAIN_LLM_* variables set:
echo "We decided to cache sessions in Redis because Postgres was too slow under load." \
  | node dist/bin/brain.js learn
```

Without a LLM (no marker) **nothing** is stored here. With an active LLM a
decision or experience should be extracted and saved — the output lists the
created entries.

### How extraction combines both sources

When a LLM is active, **both** sources are combined for each text: the marker
heuristic **and** the LLM extraction. Results are deduplicated via the stable
ID — the LLM only adds additional coverage; it never overwrites anything.
Behaviour without a LLM remains fully deterministic.
