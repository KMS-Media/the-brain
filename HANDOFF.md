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

## §16 Performance — ERLEDIGT
Benchmark @102k Nodes + 30k Edges: `search()` median **82 ms** (Ziel ≤100 ms).
Umgesetzt: (a) Traversal gebündelt (label-loses `MATCH (a)-[]-(b) WHERE a.id IN $ids`, je 1 Query statt N+1); (b) schlanke Suche — der Cosine-Scan liefert nur `id` + Ranking-Felder, Render-Felder werden per `hydrate()` nur für die finale Top-N nachgeladen (377→82 ms-Pfad: voller Knoten pro Scan-Treffer kostete ~22 ms extra); (c) `bumpUsage` gebündelt.
**Vektorindex bewusst NICHT verwendet:** Benchmark zeigte HNSW 9 ms vs. schlanke Brute-Force 15 ms (single-label@100k) — ~6 ms Gewinn, aber 69 s Bulk-Build + ~6 ms/Insert Schreib-Strafe + Betriebskomplexität. Lohnt erst bei Millionen Nodes; dann `CREATE_VECTOR_INDEX`/`QUERY_VECTOR_INDEX` (in Kuzu 0.11 verfügbar, bulk-build NACH dem Laden) erwägen.

## Offene PRD-Punkte — ALLE ERLEDIGT
- **§9 Intent Analysis** ✅ `src/retrieval/intent.ts` — heuristische Prompt-Klassifikation; fokussierte Labels bekommen mehr Suchbreite + kleinen Score-Boost.
- **§15 `embedding_version`** ✅ in `RANK`-Spalten + `config.EMBEDDING_VERSION`; idempotente `ALTER TABLE ... ADD IF NOT EXISTS`-Migration für Alt-DBs.
- **§12 semantisches Finding-Merging** ✅ Context Builder verschmilzt per Wort-Jaccard (≥0.6) innerhalb gleicher Label; höchstgerankte Formulierung bleibt.
- **§17 Verschlüsselbarer Speicher** ✅ `src/backup.ts` — `brain backup`/`restore`, AES-256-GCM (scrypt) via `BRAIN_BACKUP_KEY`. WICHTIG: `Memory.backup()` ruft `db.checkpoint()` (Daten liegen sonst nur im WAL und fehlen in der Datei-Kopie).

Der gesamte MVP-Pflichtumfang (§19) + die in §16/§14 genannten Ziele sind umgesetzt. Verbleibend sind nur noch §21-Zukunftsthemen (V2).

## Stolperfallen aus dieser Phase
- Kuzu `graph.kuzu` ist eine **Datei**; Daten liegen bis `CHECKPOINT` im WAL. Datei-Kopie ohne vorheriges Checkpoint = leer/„Table does not exist".
- **mmap-Falle (wichtig):** jede `new kuzu.Database` reserviert per Default **8 TiB** virtuelle mmap (maxDBSize). Viele DBs in einem Prozess (Cross-Project-Suche, Tests) erschöpfen den Adressraum → „Mmap for size … failed" bzw. SIGSEGV. Fix: `config.MAX_DB_SIZE` (4 GiB, Zweierpotenz) als 5. Konstruktor-Arg. **Das war die wahre Ursache der gesamten früheren Test-Flakiness** — nicht onnxruntime. Mit dem Cap läuft die Suite wieder mit Standard-Isolation (Prozess pro Datei) stabil.
- `conn.closeSync()`/`db.closeSync()` existieren, können aber nativ crashen → `GraphDB.close()` bleibt no-op; stattdessen immer `checkpoint()` vor Datei-Zugriff.
- Nur **eine** Kuzu-Database pro Pfad pro Prozess offen halten.

## §21 V2 — ALLE umgesetzt ✅
- **MCP-Server** (`src/mcp/server.ts`, jetzt 13 Tools)
- **Multi-Projekt-Graph + Cross-Project-Transfer** (`src/multi.ts`)
- **Visual Graph Explorer** (`src/explorer.ts`, self-contained HTML)
- **Wissenskonsolidierung** (`src/consolidate.ts`) — Merging inkl. Relationship-Rewiring über `REL_DEFS` (Single-Source-of-Truth in `schema.ts`)
- **Agent-basierte Wissenspflege** (`src/curate.ts`, `brain curate`) — consolidate + Findings→Standards befördern + optionales Pruning
- **Team Sharing** (`src/share.ts`, `brain share export|import`) — portable, mergebare, optional verschlüsselte Bundles
- **Lokale LLM-Integration** (`src/llm.ts`) — OpenAI-kompatibel (Ollama/llama.cpp), augmentiert die Extraktion; via `BRAIN_LLM_URL`, optional, graceful fallback
- **GitHub-Integration** (`src/github.ts`, `brain github`) — Issues→Problem, PRs→Decision, Commit→PR via `gh` CLI
- **VS-Code-Extension** (`extension/`) — eigenes Paket, kompiliert (`cd extension && npm install && npm run compile`), Thin-Client über die `brain` CLI

Cross-Process-Locking GELÖST: Kuzu ist eine eingebettete Single-Writer-DB; mehrere Prozesse (MCP-Server, Hooks, CLI) auf derselben Datei kollidierten (Lock-Fehler + WAL-Races). Lösung: kooperativer, prozess-intern ref-gezählter Lockfile `.brain.lock` (`src/db/lock.ts`) serialisiert den Zugriff; `GraphDB.dispose()` schließt Kuzu via `closeSync` und gibt den Lock frei; der MCP-Server öffnet/schließt pro Tool-Aufruf (`withMemory`), statt die DB dauerhaft zu halten. `close()` == `dispose()`. Wichtig: `.brain.lock` ist vom Backup ausgeschlossen (sonst trägt der Restore einen toten Lock ins Ziel). Echter HNSW-Vektorindex erst bei Millionen Nodes.

## CI
`.github/workflows/ci.yml` läuft bei Push auf main/dev und PRs: Job **quality** (npm ci + build + test auf Node 20 & 22, Modell-Cache) und **extension** (Extension kompilieren). Grün auf `main`.

## Test-Ausführung (wichtig)
`npm test` → `node test/run.mjs` (eigener Runner). Der Runner setzt `BRAIN_FAKE_EMBED=1`: die Tests nutzen ein deterministisches Hashing-Embedding (kein onnxruntime → stabil & schnell, auf CI essenziell, da das native Modell quer über viele kurzlebige Prozesse auch MITTEN im Test crasht). Token-Überlappung bleibt erhalten, daher gelten alle Semantik-Ordering-Assertions weiter. Ein winziger Nicht-Ganzzahl-Offset hält Kuzu bei `DOUBLE[]` (sonst `INT64[]` → `array_cosine_similarity` lehnt ab). `test/embedder.test.ts` setzt `BRAIN_FAKE_EMBED=0` und deckt das echte Modell ab. Hintergrund: die nativen Libs (onnxruntime/Kuzu) **crashen intermittierend in ihren Destruktoren beim Prozess-Exit** (`libc++abi: mutex lock failed`) — NACHDEM alle Subtests grün sind. Der Exit-Code ist damit unzuverlässig, die berichteten Testergebnisse sind korrekt. `test/run.mjs` führt jede Datei einzeln aus und bewertet pass/fail anhand der Subtest-Ergebnisse (✔/✖ mit Dauer), ignoriert den reinen Exit-Crash, meldet echte Fehlschläge aber weiterhin. `npm run test:raw` ist der unbearbeitete Node-Test-Lauf. Nicht zurück auf den rohen Lauf als `test` stellen — er ist flaky durch den Exit-Crash.

## Git
- `dev` lokal = `65e0f05`, eine Commit vor `origin/dev`/`origin/main` (`9777f6b`).
- Remote: `git@github.com:KMS-Media/the-brain`. Solo-Repo; `--force-with-lease` ist nach Bedarf ok.
- Letzte Commits: `65e0f05` (Stop-Hook/§14) · `9777f6b` (Email-Fix) · `fdb7840` (Ingest) · `cdd5ca0` (MVP).
