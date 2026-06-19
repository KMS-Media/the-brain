# Session-Handoff — the_brain

Stand: 2026-06-19. Übergabe an opencode zur Weiterarbeit.

## Was das Projekt ist
Lokales, persistentes Gedächtnis-Plugin für Claude Code, das die PRD in
`Anforderungen.md` (deutsch, MVP) umsetzt. Vollständig lokal/offline. Detaillierte
Übersicht: `README.md`. Phasenplan: `PLAN.md`.

## Aktueller Stand
- **MVP-Pflichtumfang (§19) vollständig.**
- **Strukturelle Auto-Erfassung** (`brain ingest` / MCP `ingest_repository`): Project/Directory/File aus `git ls-files`, GitCommit/MODIFIES aus `git log`.
- **Automatisches Lernen (§14) vollständig**: Stop-Hook (`src/hooks/learn.ts`) liest die letzte Assistant-Antwort aus dem Transkript und persistiert ADR/FINDING/LEARNED/RULE/NOTE-Marker. Idempotent über deterministische IDs; Findings zählen `frequency` hoch (§13).
- **Tests: 25/25 grün, stabil** (`npm test`). Build sauber (`npm run build`).
- Branch `dev` = `65e0f05`, **1 Commit vor `origin/dev`** (noch nicht gepusht, siehe unten).

## Build / Test / Run
```bash
npm install        # native scripts genehmigen falls nötig (kuzu, onnxruntime, sharp)
npm run build      # tsc → dist/
npm test           # 25 Tests (läuft Single-Process, s.u.)
node dist/bin/brain.js <init|ingest|query|search|component|learn|serve|mcp|backup>
```

## Architektur (Kurzfassung)
Alle Schnittstellen → `Memory`-Fassade (`src/core.ts`) → Retrieval/Learning → Embeddings/Repository/GraphDB → Kuzu unter `~/.claude-memory/<projekt>/`.
- `src/db/` — Kuzu-Wrapper + Schema (11 Node-Typen, 12 Relationships) + Repository
- `src/embeddings/` — bge-small (384d), lokales ONNX
- `src/retrieval/` — search (in-DB `array_cosine_similarity` + Graph-Traversal) · ranking (§10-Formel) · contextBuilder (§11/§12)
- `src/graphql/` — graphql-yoga (search/context/component + Mutations)
- `src/mcp/` — MCP-stdio-Server, 10 Tools
- `src/hooks/` — `inject.ts` (UserPromptSubmit) · `learn.ts` (Stop)
- `src/ingest/` — strukturelle Auto-Erfassung
- `src/learning/extractor.ts` — Marker-Heuristik

## Verifizierte Fakten & Stolperfallen (WICHTIG)
1. **Kuzu `TIMESTAMP` → JS `Date`** beim Lesen (nicht String). Siehe `recencyScore`.
2. **MCP: nur `console.error`**, nie `console.log` (stdout = JSON-RPC).
3. **`array_cosine_similarity(a,b)`** existiert nativ in Kuzu → für semantische Suche genutzt (kein Vektorindex im MVP).
4. **`RETURN n`** liefert `{...props, _label, _id}`; `RETURN n.*` präfixt Keys mit `n.`. Code nutzt `RETURN n`.
5. **GitCommit-Knoten muss VOR seinen MODIFIES-Kanten** angelegt werden (sonst MATCH leer).
6. **Modell-Cache ist global** (`~/.claude-memory/models`), entkoppelt von `BRAIN_HOME`.
7. **Tests laufen Single-Process** (`--test-isolation=none`): mehrere Prozesse, die onnxruntime separat initialisieren, lassen die native Lib intermittierend abstürzen. NICHT auf prozess-pro-Datei zurückstellen.
8. Marker-Syntax: `ADR:/DECISION:`, `FINDING[sev]:`, `LEARNED:/ERFAHRUNG:`, `RULE:/REGEL:`, `NOTE:/WISSEN:` (Trenner `|` bzw. `->`).

## Offene PRD-Punkte (Priorität absteigend)
1. **§9 Intent Analysis** fehlt — Prompt wird direkt eingebettet, ohne Absichts-/Themenklassifikation.
2. **§16 Performance @ Skala unverifiziert** — Retrieval macht N+1-Queries pro Kandidat (`src/retrieval/search.ts`, `expand`/`scoreGraphConnections`). Bei 100k+ Nodes/1M+ Edges vermutlich zu langsam. Lösung: nativer HNSW-Vektorindex (`CREATE_VECTOR_INDEX`/`QUERY_VECTOR_INDEX`, in Kuzu 0.11 verfügbar) + Batch-Traversal statt Schleifen.
3. **§17 Verschlüsselbarer Speicher** — keine Verschlüsselung implementiert (Rest von §17 erfüllt).
4. **§15 `embedding_version`** — nur `embedding` + `embeddingModel` gespeichert; Versionsfeld fehlt.
5. **§12 semantisches Zusammenführen ähnlicher Findings** — aktuell nur zeilenbasiertes Dedup.

## Nächster sinnvoller Schritt
Punkt #2 (Skalierung via Vektorindex) bringt den größten Nutzen für reale Repos — die Brute-Force-Pfade in `search.ts` durch `QUERY_VECTOR_INDEX` ersetzen und Traversal batchen. Davor mit einem Lasttest (synthetische 100k Nodes) den Ist-Zustand messen.

## Git
- `dev` lokal = `65e0f05`, eine Commit vor `origin/dev`/`origin/main` (`9777f6b`).
- Remote: `git@github.com:KMS-Media/the-brain`. Solo-Repo; `--force-with-lease` ist nach Bedarf ok.
- Letzte Commits: `65e0f05` (Stop-Hook/§14) · `9777f6b` (Email-Fix) · `fdb7840` (Ingest) · `cdd5ca0` (MVP).
