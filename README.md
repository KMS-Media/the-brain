# 🧠 the_brain — Local Memory for Claude Code

A local, persistent **project memory** for Claude Code. It gives Claude a long-term
graph-backed memory of decisions, review findings, coding standards, experiences
and project knowledge — and injects the relevant pieces **before every prompt**.

Implements the PRD in [`Anforderungen.md`](./Anforderungen.md). Everything runs
**100 % locally**: no cloud, no telemetry, no external embedding APIs (PRD §3, §17).

## What it does

- **Projektgedächtnis** — knowledge persists across sessions in an embedded graph DB.
- **Entscheidungswissen** — architecture decisions (ADRs) are never lost.
- **Review-Lernen** — past review findings get the **highest** retrieval priority so the same mistake isn't repeated.
- **Wissensvernetzung** — relationships between components, decisions, findings and experiences are traversable.
- **Token-Einsparung** — only the most relevant context is assembled within a token budget.

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

| Layer | Tech | File |
|-------|------|------|
| Graph DB | [Kuzu](https://kuzudb.com) (embedded) | `src/db/` |
| Embeddings | `@huggingface/transformers`, bge-small-en-v1.5 (384d), local ONNX | `src/embeddings/` |
| Retrieval | semantic (`array_cosine_similarity`) + graph traversal + ranking | `src/retrieval/` |
| API | `graphql-yoga` | `src/graphql/` |
| Integration | `@modelcontextprotocol/sdk` (MCP) + prompt hook | `src/mcp/`, `src/hooks/` |

### Ranking (PRD §10)

```
score = 0.40·semantic + 0.25·graph + 0.15·importance + 0.10·usage + 0.10·recency
```

### Priority in the context block (PRD §11)

1. Review Findings → 2. Coding Standards → 3. Decisions → 4. Architecture →
5. Experiences → 6. Knowledge

## Install

```bash
npm install
npm run build          # compiles to dist/
```

The first run downloads the embedding model (~30 MB) into `~/.claude-memory/models`
and caches it. Set `BRAIN_OFFLINE=1` afterwards to forbid any network access.

## Use as a Claude Code plugin

The repo is a ready Claude Code plugin:

- `.claude-plugin/plugin.json` — manifest
- `hooks/hooks.json` — registers two hooks:
  - `UserPromptSubmit` → retrieval before every prompt (`dist/hooks/inject.js`)
  - `Stop` → automatic learning after every response (`dist/hooks/learn.js`): the
    last assistant turn is scanned for ADR/FINDING/LEARNED/RULE/NOTE markers and
    persisted (PRD §14). Stable ids make this idempotent; recurring review
    findings accumulate `frequency` (PRD §13).
- `.mcp.json` — registers the `the-brain` MCP server (10 tools)

After `npm run build`, point Claude Code at this directory as a plugin. The MCP
tools and the prompt hook become available automatically.

**MCP tools:** `memory_context`, `memory_search`, `memory_component`,
`remember_decision`, `remember_experience`, `remember_review_finding`,
`remember_knowledge`, `remember_standard`, `ingest_repository`, `learn_from_text`.

## Use from the CLI

```bash
npm run build
node dist/bin/brain.js init                       # create the graph for this project
node dist/bin/brain.js learn "FINDING[high]: SQL injection -> use params"
node dist/bin/brain.js ingest                     # scan repo structure + git history into the graph
node dist/bin/brain.js query "building the search endpoint"   # prints the context block
node dist/bin/brain.js search "authentication"    # ranked hits as JSON
node dist/bin/brain.js component "UserService"    # component view
node dist/bin/brain.js serve                       # GraphQL on 127.0.0.1:4123
node dist/bin/brain.js mcp                          # MCP stdio server
node dist/bin/brain.js backup                       # archive the DB (encrypted if BRAIN_BACKUP_KEY set)
node dist/bin/brain.js restore <file>               # restore a backup archive
```

### Knowledge markers (for `learn` / `learn_from_text`)

The heuristic extractor (PRD §14) recognizes line markers in any text:

| Marker | Becomes | Example |
|--------|---------|---------|
| `DECISION:` / `ADR:` | Decision | `ADR: Use Kuzu \| embedded graph DB` |
| `FINDING[sev]:` | ReviewFinding | `FINDING[high]: secret in code -> use env` |
| `LEARNED:` / `ERFAHRUNG:` | Experience | `LEARNED: flaky test -> raise timeout` |
| `RULE:` / `REGEL:` | CodingStandard | `RULE: validate input \| with zod` |
| `NOTE:` / `WISSEN:` | Knowledge | `NOTE: deploy \| runs on Node LTS` |

## GraphQL API (PRD §8)

`POST http://127.0.0.1:4123/graphql`

```graphql
query  { context(query: "Implement OAuth") { summary markdown findings decisions } }
query  { search(query: "UserService", limit: 20) { label score props } }
query  { component(name: "UserService") { decisions dependencies findings experiences } }
mutation { rememberReviewFinding(rule: "...", severity: "high", fix: "...") { id label } }
```

## Configuration (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `BRAIN_HOME` | `~/.claude-memory` | root storage dir |
| `BRAIN_PROJECT_LOCAL` | – | `1` → store under `<project>/.project-memory` |
| `BRAIN_EMBEDDING_MODEL` | `Xenova/bge-small-en-v1.5` | local embedding model |
| `BRAIN_TOKEN_BUDGET` | `1500` | context block token budget |
| `BRAIN_GRAPHQL_PORT` | `4123` | GraphQL port |
| `BRAIN_OFFLINE` | – | `1` → forbid model downloads |
| `BRAIN_BACKUP_KEY` | – | passphrase → `backup` produces an AES-256-GCM encrypted archive |

## Data model

11 node types (Project, Component, File, Directory, GitCommit, Knowledge,
Decision, Experience, ReviewFinding, CodingStandard, Problem) and the full
relationship set from PRD §7 (`CONTAINS`, `USES`, `CALLS`, `DEPENDS_ON`,
`AFFECTS`, `REPLACES`, `IMPLEMENTS`, `VIOLATES`, `SOLVES`, `RELATES_TO`,
`MODIFIES`, `FIXES`). See `src/db/schema.ts`.

**Structural auto-ingestion** (`brain ingest` / `ingest_repository`) populates the
structural half automatically: `Project`, `Directory` and `File` nodes from
`git ls-files` (so `.gitignore` is honored, checksums are git blob hashes), plus
recent `GitCommit` nodes with `MODIFIES` edges from `git log`. See `src/ingest/`.
Components are still captured manually / via the extractor — auto-detecting
architectural components from code is intentionally out of MVP scope.

## Performance (PRD §16)

Benchmarked at **102k nodes + 30k edges**: `search()` runs in **~82 ms median**
(target ≤100 ms). Achieved by a lean semantic scan (the in-DB cosine scan
returns only `id` + ranking columns; full render fields are hydrated for the
final slice only) and batched graph traversal (one label-less
`MATCH (a)-[]-(b) WHERE a.id IN $ids` query each, not one per candidate).

The native Kuzu HNSW vector index is deliberately **not** used: benchmarks
showed it only ~6 ms faster at 100k while making writes ~10× slower (index
maintenance per insert) — it only pays off at millions of nodes.

## Tests

```bash
npm test    # core round-trips, semantic search, prioritization, component
            # traversal, ranking, extractor, ingest, auto-learning hook,
            # intent analysis, finding-merge, backup/restore, multi-project
```

## Security (PRD §17)

Fully local · no telemetry · no cloud · no tracking. All data lives under
`BRAIN_HOME` and is never transmitted.

**Backups & encryptable storage:** `brain backup` packs the database into a
single archive; with `BRAIN_BACKUP_KEY` set it is encrypted with AES-256-GCM
(key derived via scrypt) — restore needs the same key. `brain restore <file>`
restores it. Kuzu has no at-rest encryption of its own, so the live working
copy is plaintext; the persisted/portable backup is what can be encrypted.
