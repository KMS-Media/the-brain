# Issue: `remember_knowledge` crasht den MCP-Server hart bei gesetztem `tags`-Parameter (`STRING[]`-Binding)

**Status:** Open
**Schweregrad:** High — jeder `remember_knowledge`-Call mit `tags` killt den kompletten MCP-Server-Prozess; nur ein voller Reconnect stellt ihn wieder her.
**Betroffene Version:** the-brain `0.1.0` (stdio MCP server)
**Erstbeobachtung:** 2026-07-02
**Reporter:** Kai (via Claude Code, Projekt `workbench`)

---

## Zusammenfassung

Ein `remember_knowledge`-Aufruf mit gesetztem `tags`-Array beendet den the-brain-MCP-Server-Prozess
sofort (stdio-Verbindung schließt „cleanly"). Der Client bekommt `MCP error -32000: Connection closed`,
alle Folge-Tools sind bis zum Reconnect nicht verfügbar. `remember_review_finding` (und andere Nodes
**ohne** `STRING[]`-Spalte) funktionieren im selben Ablauf einwandfrei.

Das Verhalten ist **reproduzierbar** — 3 von 3 `remember_knowledge`-Calls mit `tags` crashten,
alle Calls ohne `tags` liefen durch.

---

## Umgebung

- Server: `the-brain` v0.1.0, Transport stdio
- Storage-Modus: project-local `.project-memory/graph.kuzu` (Kuzu embedded)
- Aufrufender Client: Claude Code, `cwd = /Users/kai_schwendig/projects/workbench`
- Embedding: lokal (`@huggingface/transformers`, bge-small, 384 dim)

---

## Reproduktion

1. MCP-Server läuft, mehrere `remember_review_finding`-Calls absetzen → **alle OK** (30–65 ms).
2. Einen `remember_knowledge`-Call mit `tags: ["EA-7983", "docker", ...]` absetzen.
3. **Ergebnis:** Tool schlägt nach ~60 ms fehl mit `MCP error -32000: Connection closed`,
   Server-Prozess ist weg. Nächster Tool-Call: „No such tool available" bis Reconnect.
4. Gegenprobe: identischer `remember_knowledge`-Call **ohne** `tags` → **OK**, id wird zurückgegeben.

### Konkrete Belege (diese Session)

- 7× `remember_review_finding` erfolgreich (IDs vergeben).
- 2× `remember_knowledge` **mit** `tags` → beide `Connection closed`, danach Server-Disconnect.
- Nach Reconnect: 2× `remember_knowledge` **ohne** `tags` → erfolgreich
  (`92ba88c9-d514-49b2-bad5-9640d8af5382`, `68b3b10d-e743-4b2a-9244-2544d3ef4fc5`).

### MCP-Log-Auszug

`~/Library/Caches/claude-cli-nodejs/-Users-kai-schwendig-projects-workbench/mcp-logs-plugin-the-brain-the-brain/2026-07-02T05-57-27-512Z.jsonl`:

```
06:02:01.730  Tool 'remember_review_finding' completed successfully in 46ms
06:02:05.127  Calling MCP tool: remember_knowledge
06:02:05.189  UNKNOWN connection closed after 19s (cleanly)
06:02:05.189  Cleared connection cache for reconnection
06:02:05.189  Tool 'remember_knowledge' failed after 0s: MCP error -32000: Connection closed
06:03:45.219  Starting connection with timeout of 30000ms   (erst manueller /mcp-Reconnect)
06:03:45.445  Server stderr: 🧠 the-brain MCP server running on stdio
```

Das „cleanly" + der ~62 ms-Abstand zeigen: der Prozess **exited/abortet** beim Verarbeiten des
Calls (kein Timeout, kein Protokollfehler) — typisch für einen Crash in der nativen Schicht.

---

## Root-Cause-Analyse

Sowohl `ReviewFinding` als auch `Knowledge` laufen durch denselben Pfad
(`Repository.upsertNode` → `embed()` → `db.query(MERGE … SET …)`), und **beide** binden ein
`FLOAT[]`-`embedding`-Array. Numerische Array-Bindings funktionieren also (Findings gehen durch).

Der **einzige strukturelle Unterschied** ist der `tags`-Parameter:

- `src/db/schema.ts:37` — `Knowledge(… tags STRING[], …)`
- `ReviewFinding` hat **keine** `STRING[]`-Spalte.

Kette:
1. `src/mcp/server.ts` → `rememberKnowledge` reicht `tags: string[]` als Prop durch.
2. `src/db/repo.ts:135 sanitize()` reicht das Array **unverändert** weiter (kein Cast/Serialisieren).
3. `src/db/kuzu.ts:112 query()` → `conn.prepare(cypher)` + `conn.execute(stmt, params)` bindet
   `tags` als JS-`string[]` an einen `STRING[]`-Parameter.
4. Das native Kuzu-N-API-Binding für **`STRING[]`-Parameter** stürzt ab → der ganze
   Node-Prozess terminiert → stdio schließt → MCP-Client sieht `Connection closed`.

**Fazit:** Nicht das Array-Binding generell ist kaputt (FLOAT[] geht), sondern spezifisch die
Bindung von **String-Arrays als Prepared-Statement-Parameter** in der eingesetzten Kuzu-Version.

### Bestätigung
Identischer `remember_knowledge`-Call ohne `tags` läuft durch → `tags STRING[]` ist der Trigger
(kausal isoliert, nicht bloß korreliert).

### Offen / nicht isoliert
- Ob auch ein **leeres** `tags: []` crasht (getestet wurde nur „weggelassen" vs. „gesetzt & nicht-leer").
- Ob es ein reiner Kuzu-Versions-Bug ist oder erst durch Kombination FLOAT[] + STRING[] in einem `SET` auftritt.

---

## Impact

- Datenverlust-Risiko: der Call schlägt fehl, die Erkenntnis wird **nicht** persistiert.
- Kollateral: der Crash reißt die **gesamte** MCP-Session mit; nachfolgende Tools benötigen manuellen Reconnect.
- `remember_decision`/`remember_experience` sind vermutlich **nicht** betroffen (keine `STRING[]`-Spalte),
  sollten aber gegengeprüft werden.

---

## Vorgeschlagener Fix (Optionen)

1. **STRING[]-Parameter als Cypher-Listen-Literal inlinen** statt als gebundenen Parameter:
   in `kuzu.ts`/`repo.ts` für Array-of-String-Props eine `[...]`-Literal-Klausel bauen
   (Werte escapen) statt `$tags` zu binden → umgeht den crashenden nativen Bind-Pfad.
2. **`tags` als serialisierte `STRING`-Spalte** (JSON) speichern und beim Lesen parsen
   (Schema-Änderung `tags STRING`), falls Kuzu-`STRING[]`-Param-Binding grundsätzlich instabil ist.
3. **Kuzu-Version prüfen/upgraden** — ggf. bekannter Bug im `STRING[]`-Parameter-Binding.
4. **Defensiv in `upsertNode`**: `tags` vor dem Query validieren/normalisieren und den nativen Aufruf
   in try/catch kapseln, sodass ein Binding-Fehler eine saubere Tool-Fehlermeldung liefert statt den
   Prozess zu killen (falls der Crash abfangbar ist — bei echten N-API-Aborts ggf. nicht).

## Workaround (bis Fix)

`remember_knowledge` **ohne** `tags` aufrufen; Tags bei Bedarf in den `content`-Text aufnehmen.
(So wurden die EA-7983-Knowledge-Nodes dieser Session importiert.)

---

## Resolution (2026-07-02)

Die `tags STRING[]`-Hypothese wurde durch direkte Reproduktion **widerlegt**: ein isoliertes
`MERGE … SET n.tags = $tags` mit `STRING[]`-Parameter (auch kombiniert mit `FLOAT[]`-`embedding`
im selben `SET`) läuft in Kuzu 0.11.3 zuverlässig durch — kein Crash, in keinem Testlauf.

**Tatsächliche Ursache:** `GraphDB.close()`/`Memory.close()` (aufgerufen von jedem One-Shot-Prozess:
CLI-Kommandos in `src/bin/brain.ts`, dem `Stop`-Hook in `src/hooks/learn.ts`, `graphql/server.ts`
beim Shutdown) rief bislang denselben Pfad wie `dispose()` auf und schloss damit **synchron, im
selben Tick**, das native Kuzu-Handle (`closeSync()`) direkt nach einem Embedding-auslösenden
Schreibzugriff. Das native `closeSync()` kollidiert dabei mit dem noch laufenden nativen
Aufräumvorgang der ONNX-Runtime (`@huggingface/transformers`) und führt reproduzierbar zu einem
SIGSEGV des gesamten Prozesses — **unabhängig von `tags`**: identische Reproduktion mit und ohne
`tags` crashte in Direkttests je 3/3-mal.

Der Effekt korrelierte in der Original-Session zufällig mit `remember_knowledge`, weil das der
nächste Tool-Call nach einer Idle-Pause war; `remember_review_finding` löst denselben
Embedding-Pfad aus (`ReviewFinding` ist ebenfalls ein `KNOWLEDGE_LABEL`), crashte in dieser Session
aber einfach nicht, weil dort kein `close()`/`dispose()` direkt danach im selben Tick lief.

**Fix:** `GraphDB.close()` (src/db/kuzu.ts) gibt jetzt **nur noch den Lock frei** und überspringt
das native Kuzu-Teardown — sicher für Prozesse, die sowieso gleich beendet werden (Kuzu committet
pro Statement, das Betriebssystem räumt native Handles beim Prozessende ohnehin auf).
`GraphDB.dispose()` (voller nativer Teardown) bleibt unverändert für den einzigen Fall, der ihn
wirklich braucht: den langlebigen MCP-Server (`MemoryGate`), der die Datei aktiv an andere Prozesse
zurückgeben muss, ohne selbst zu beenden.

Tests: `test/native-close-safety.test.ts` (neu, reproduziert den Crash mit echtem Embedder in
Kindprozessen, mit UND ohne `tags`) sowie eine ergänzte Assertion in `test/concurrency.test.ts`.
