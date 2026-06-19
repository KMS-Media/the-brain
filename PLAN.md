# Implementierungsplan — Claude Code Memory Plugin ("the_brain")

Basierend auf `Anforderungen.md` (PRD v1.0, MVP).

## Phase 0 — Documentation Discovery (ABGESCHLOSSEN)

Verifizierte APIs (Quellen: offizielle Docs/GitHub/npm, per Subagent-Recherche):

### Kuzu Graph Database — npm `kuzu` (v0.11.x)
- `import { Database, Connection } from "kuzu"`
- `new Database(path)` — `path` String, `":memory:"` für In-Memory. Weitere optionale Positionsargumente vorhanden.
- `new Connection(db)` — `query()`, `prepare()`, `execute(stmt, params)` sind async.
- Ergebnis: `await result.getAll()` → `Record<string,any>[]`; `hasNext()/getNext()`; `close()`.
- DDL ist Cypher: `CREATE NODE TABLE`, `CREATE REL TABLE (FROM A TO B, ...)`, Typen `STRING/INT64/DOUBLE/TIMESTAMP/SERIAL/BOOLEAN`, Arrays `FLOAT[N]`, Listen `STRING[]`.
- Vektorsuche: natives `vector`-Extension, `CALL CREATE_VECTOR_INDEX(...)` / `CALL QUERY_VECTOR_INDEX(...)`. Außerdem `array_cosine_similarity(a,b)` für Brute-Force.
- ⚠️ Empirisch zu verifizieren: exakte Konstruktor-Signatur, Vector-Index-Parametersyntax, ob `vector` vorinstalliert ist. → Brute-Force-Cosine als robuster Fallback (MVP-Größe unkritisch).

### Embeddings — npm `@huggingface/transformers`
- `import { pipeline, env } from "@huggingface/transformers"`
- `const ext = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5")` (384 dim)
- `const out = await ext([text], { pooling: "mean", normalize: true })` → `out.data` (Float32Array) → `Array.from(...)`.
- Lokal, Modell-Cache via `env.cacheDir`. Keine Cloud.

### MCP Server — npm `@modelcontextprotocol/sdk` (v1.x) + `zod`
- `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"`
- `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"`
- `server.registerTool(name, {title, description, inputSchema}, async (args) => ({ content:[{type:"text", text}] }))`
- `await server.connect(new StdioServerTransport())`. Niemals `console.log` (korruptiert stdio) — nur `console.error`.
- ⚠️ Exakte registerTool-Signatur empirisch gegen installiertes SDK verifizieren.

### GraphQL — npm `graphql-yoga` + `graphql` (+ `graphql-scalars` für JSON)
- `import { createYoga, createSchema } from "graphql-yoga"`
- `createSchema({ typeDefs, resolvers })`; Resolver `(parent, args, context, info)`.
- `createServer(yoga).listen(port)`; Context-Funktion injiziert DB/Services.

## Architektur

```
Claude Code
   ↓ (UserPromptSubmit Hook)         ↓ (MCP stdio)        ↓ (GraphQL HTTP)
 hook/inject.ts                    mcp/server.ts        graphql/server.ts
        \                              |                      /
         \____________________ core (gemeinsam) ____________/
                                    |
   retrieval(pipeline,ranking,contextBuilder) · learning(extractor)
                                    |
                 embeddings(embedder) · db(kuzu, schema, repo)
                                    |
                          Kuzu @ ~/.claude-memory/<project>/
```

Alle Schnittstellen (MCP-Tools, GraphQL-Resolver, Hook) rufen denselben **Core** auf.

## Phasen

### Phase 1 — Projekt-Setup & DB-Layer
- `package.json` (ESM, type:module), `tsconfig.json`, deps installieren.
- `src/config.ts`: Speicherorte `~/.claude-memory/` (+ projektbezogen), Token-Budget, Modellname.
- `src/db/kuzu.ts`: Database/Connection-Wrapper, `query`/`run`-Helper. **Empirischer Smoke-Test** der Kuzu-API.
- `src/db/schema.ts`: alle Node-Tabellen (Project, Component, File, Directory, GitCommit, Knowledge, Decision, Experience, ReviewFinding, CodingStandard, Problem) + Rel-Tabellen (CONTAINS, USES, CALLS, DEPENDS_ON, AFFECTS, REPLACES, IMPLEMENTS, VIOLATES, SOLVES, RELATES_TO, MODIFIES, FIXES). Embedding-Spalte `FLOAT[384]` auf wissensartigen Nodes.
- Verifizierung: Smoke-Test legt DB an, schreibt/liest Node.

### Phase 2 — Embeddings
- `src/embeddings/embedder.ts`: Singleton-Pipeline bge-small, `embed(text): Promise<number[]>`, `cosine(a,b)`.
- Verifizierung: Test erzeugt 384-dim Vektor; cosine(x,x)≈1.

### Phase 3 — Repository / CRUD
- `src/db/repo.ts`: typsichere Insert/Upsert/Get für jeden Node-Typ + Relationship-Anlage. Embeddings beim Insert erzeugen.
- `src/types.ts`: TS-Interfaces für alle Node-Typen.
- Verifizierung: Round-Trip-Tests pro Node-Typ + eine Relationship.

### Phase 4 — Retrieval-Pipeline
- `src/retrieval/search.ts`: semantische Suche (cosine über Kandidaten), Graph-Traversal (Nachbarn), Relationship-Expansion.
- `src/retrieval/ranking.ts`: Score = 0.40·semantic + 0.25·graph + 0.15·importance + 0.10·usage + 0.10·recency.
- `src/retrieval/contextBuilder.ts`: Dedup, Priorisierung (ReviewFindings > Standards > Decisions > Architektur > Experiences > Knowledge), Token-Budget, Zusammenfassung → Markdown-Kontext.
- `src/retrieval/index.ts`: `context(query)` + `search(query)` + `component(name)`.
- Verifizierung: Seed-Daten, Query liefert priorisierte, deduplizierte Treffer; ReviewFindings zuerst.

### Phase 5 — GraphQL API
- `src/graphql/schema.ts` + `resolvers.ts`: Queries `search`, `context`, `component`; Mutations zum Anlegen aller Wissens-Nodes.
- `src/graphql/server.ts`: graphql-yoga auf konfigurierbarem Port.
- Verifizierung: Server startet, `context`-Query liefert Daten.

### Phase 6 — MCP Server (Claude-Code-Integration)
- `src/mcp/server.ts`: Tools `memory_context`, `memory_search`, `memory_component`, `remember_decision`, `remember_experience`, `remember_review_finding`, `remember_knowledge`, `remember_standard`.
- `.mcp.json` für Claude Code.
- Verifizierung: Server startet über stdio; Tools-Liste korrekt.

### Phase 7 — Automatisches Lernen + Prompt-Hook
- `src/learning/extractor.ts`: heuristische Extraktion (ADR/Erfahrung/Regel/Finding) aus Texten → Graph-Update.
- `hooks/inject.ts` (UserPromptSubmit): ruft `context(prompt)` und gibt Markdown aus → wird in Prompt injiziert.
- `plugin`-Manifest/`hooks` Konfiguration.
- Verifizierung: Hook gibt für Test-Prompt relevanten Kontext aus.

### Phase 8 — CLI, Backup, Doku
- `bin/brain.ts`: `init`, `serve` (graphql), `mcp`, `add`, `query`, `backup`.
- Backup: Verzeichnis-Kopie der Kuzu-DB.
- README aktualisieren.
- Verifizierung: `brain query "..."` liefert Kontext.

### Phase 9 — Verifizierung gesamt
- `npm run build` (tsc) fehlerfrei.
- `npm test` grün.
- Anti-Pattern-Check: keine erfundenen Kuzu/MCP-APIs (grep), kein `console.log` im MCP-Server, keine Cloud-Calls.
- Erfolgskriterien gegen PRD §20 prüfen.

## Anti-Patterns / Guards
- Keine erfundenen Kuzu-Methoden — gegen installiertes Paket testen, sonst Brute-Force-Cosine.
- MCP: nur `console.error`, nie `console.log`.
- Embeddings nur lokal (`@huggingface/transformers`), keine Cloud-API.
- Alle Daten unter `~/.claude-memory/` — kein Netzwerk, keine Telemetrie.
