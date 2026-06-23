# 🧠 the_brain — Workflow & Funktionsweise

Wie das Plugin im Alltag arbeitet, wie es neues Wissen aufnimmt und wie du ein
lokales LLM anbindest. Für Installation siehe [INSTALL.md](./INSTALL.md), für
Architektur/Interna [DEVELOPER.md](./DEVELOPER.md).

---

## 1. Wie das Plugin arbeitet

the_brain hängt sich an zwei Stellen in den Claude-Code-Ablauf ein und stellt
zusätzlich Werkzeuge bereit, die Claude selbst aufrufen kann.

```
            DU stellst einen Prompt
                     │
   ┌─────────────────▼──────────────────┐
   │ UserPromptSubmit-Hook               │  (hooks/inject.js)
   │  → relevantes Wissen wird VOR dem   │
   │    Prompt eingeblendet              │
   └─────────────────┬──────────────────┘
                     ▼
            Claude beantwortet
                     │
   ┌─────────────────▼──────────────────┐
   │ Stop-Hook                           │  (hooks/learn.js)
   │  → lernt aus der Antwort dazu       │
   └─────────────────────────────────────┘

   Parallel: Claude kann jederzeit die MCP-Tools aufrufen
   (memory_context, memory_search, remember_*, …)
```

### Retrieval vor jedem Prompt

Bei jedem Prompt läuft der `UserPromptSubmit`-Hook und blendet passendes
Projektwissen ein. Intern arbeitet die Retrieval-Pipeline so:

1. **Intent-Analyse** — der Prompt wird grob klassifiziert (geht es um Review-
   Findings? Architektur? Standards? …). Passende Wissensarten bekommen mehr
   Gewicht.
2. **Embedding** — der Prompt wird lokal in einen Vektor übersetzt.
3. **Semantische Suche** — ähnliche Wissensknoten werden über Cosine-Ähnlichkeit
   gefunden (direkt in der Graph-DB).
4. **Graph-Traversal** — verbundene Knoten (z. B. die Entscheidung zu einer
   gefundenen Komponente) werden dazugeholt.
5. **Ranking** — kombinierter Score:
   `0.40·Semantik + 0.25·Graph + 0.15·Wichtigkeit + 0.10·Nutzung + 0.10·Aktualität`.
6. **Context Builder** — dedupliziert, priorisiert (**Review-Findings → Coding
   Standards → Entscheidungen → Architektur → Erfahrungen → Wissen**), fasst
   zusammen und hält ein Token-Budget ein.

Das Ergebnis ist ein kompakter Markdown-Block, den Claude vor deinem Prompt
sieht — du musst nichts tun.

### Werkzeuge, die Claude aufrufen kann (MCP)

Über den MCP-Server stehen Claude u. a. zur Verfügung:

- **Lesen:** `memory_context` (kompakter Kontext zu einer Aufgabe),
  `memory_search` (gerankte Treffer), `memory_component` (alles zu einer
  Komponente).
- **Schreiben:** `remember_decision`, `remember_experience`,
  `remember_review_finding`, `remember_knowledge`, `remember_standard`,
  `learn_from_text`.
- **Pflege:** `consolidate_memory`, `curate_memory`, `ingest_repository`,
  `ingest_github`.

### Wo die Daten liegen

| | Ort |
|---|---|
| Wissensdatenbank (pro Projekt) | `~/.claude-memory/<projekt>/` |
| Embedding-Modell-Cache | `~/.claude-memory/models/` |

Alles bleibt lokal — keine Cloud, keine Telemetrie.

---

## 2. Wie es neues Wissen erfasst

Es gibt vier Wege, wie Wissen in den Graphen kommt:

### a) Automatisch nach jeder Antwort (Stop-Hook)

Nach jeder Claude-Antwort liest der `Stop`-Hook die letzte Antwort und extrahiert
strukturiertes Wissen. Erkannt werden **Marker-Zeilen** — egal ob von dir oder
von Claude geschrieben:

| Marker | Wird zu | Beispiel |
|--------|---------|----------|
| `DECISION:` / `ADR:` | Entscheidung | `ADR: Use Kuzu \| embedded graph DB` |
| `FINDING[sev]:` | Review-Finding | `FINDING[high]: secret in code -> use env` |
| `LEARNED:` / `ERFAHRUNG:` | Erfahrung | `LEARNED: flaky test -> raise timeout` |
| `RULE:` / `REGEL:` | Coding Standard | `RULE: validate input \| with zod` |
| `NOTE:` / `WISSEN:` | Wissen | `NOTE: deploy \| runs on Node LTS` |

Eigenschaften:
- **Idempotent:** Aus dem Inhalt wird eine stabile ID abgeleitet — dieselbe
  Erkenntnis erzeugt keine Duplikate.
- **Häufigkeit:** Wiederkehrende Review-Findings erhöhen ihren `frequency`-Zähler,
  statt sich zu vervielfachen.
- **Embedding beim Schreiben:** Jeder Wissensknoten wird sofort eingebettet und
  ist damit semantisch durchsuchbar.

### b) Explizit über die CLI

```bash
node dist/bin/brain.js learn "DECISION: Use PostgreSQL | chosen for JSONB support"
```

### c) Struktur & Historie einlesen

```bash
node dist/bin/brain.js ingest        # Dateien/Verzeichnisse + Git-Historie
node dist/bin/brain.js github        # GitHub-Issues (→Problem) & PRs (→Decision)
```

### d) Direkt durch Claude

Claude kann die `remember_*`-Tools oder `learn_from_text` aufrufen, um Wissen
gezielt abzulegen.

### Qualität über Zeit (Kuration)

Damit das Gedächtnis nicht „verrauscht", gibt es einen Wartungs-Agenten:

```bash
node dist/bin/brain.js curate        # zusammenführen + Findings→Standards + ggf. pruning
```

Er fasst semantische Duplikate zusammen, befördert häufige Review-Findings zu
Coding Standards und kann veraltetes, ungenutztes Wissen entfernen
(`--prune`). Ideal regelmäßig (z. B. per Cron) ausführen.

---

## 3. Lokales LLM anbinden

Standardmäßig extrahiert the_brain Wissen rein heuristisch (die Marker oben) —
**ohne** LLM, voll deterministisch. Optional kannst du ein **lokales** LLM
anbinden, das die Extraktion verbessert: Es erkennt auch unmarkiertes,
durchaus renutzbares Wissen in Claudes Antworten und legt es strukturiert ab.
Das LLM läuft auf deinem Rechner — es verlässt nichts deinen Computer.

### Schritt 1 — Ein lokales LLM bereitstellen

Am einfachsten mit [Ollama](https://ollama.com):

```bash
# Ollama installieren, dann ein Modell laden und den Server starten:
ollama pull llama3.2
ollama serve          # stellt eine OpenAI-kompatible API unter :11434 bereit
```

Es funktioniert jedes lokale, **OpenAI-kompatible** Chat-Endpoint
(`/v1/chat/completions`) — z. B. auch llama.cpp.

### Schritt 2 — the_brain darauf zeigen lassen (Umgebungsvariablen)

| Variable | Zweck | Beispiel |
|----------|-------|----------|
| `BRAIN_LLM_URL` | Basis-URL des Endpoints (aktiviert die LLM-Nutzung) | `http://localhost:11434/v1` |
| `BRAIN_LLM_MODEL` | Modellname | `llama3.2` |
| `BRAIN_LLM_KEY` | API-Key, falls nötig (bei Ollama meist nicht) | – |

Ist `BRAIN_LLM_URL` **nicht** gesetzt oder der Endpoint nicht erreichbar, fällt
the_brain still auf die Heuristik zurück — es geht also nie kaputt.

### Schritt 3 — Wie das Plugin Zugriff bekommt (wichtig)

Hooks und der MCP-Server laufen als **Unterprozesse**, die Claude Code startet.
Sie sehen nur Umgebungsvariablen, die in **Claude Codes eigener Umgebung**
vorhanden sind. Damit **alle** Lern-Pfade (Auto-Learn-Hook, CLI, MCP) das LLM
nutzen, exportiere die Variablen, **bevor** du Claude Code startest:

```bash
# in ~/.zshrc bzw. ~/.bashrc — gilt dann für jede Claude-Code-Sitzung
export BRAIN_LLM_URL="http://localhost:11434/v1"
export BRAIN_LLM_MODEL="llama3.2"
```

Neue Shell öffnen (oder `source ~/.zshrc`), dann Claude Code starten.

Wenn du das LLM **nur** dem MCP-Server geben willst (nicht den Hooks), kannst du
die Variablen stattdessen in der MCP-Konfiguration hinterlegen:

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

> Empfehlung: über die Shell exportieren (oben) — so profitiert auch der
> Auto-Learn-Stop-Hook vom LLM, nicht nur die MCP-Tools.

### Schritt 4 — Prüfen, ob das LLM greift

```bash
# Mit gesetzten BRAIN_LLM_* Variablen:
echo "We decided to cache sessions in Redis because Postgres was too slow under load." \
  | node dist/bin/brain.js learn
```

Ohne LLM (kein Marker) wird hier **nichts** gespeichert. Mit aktivem LLM sollte
daraus z. B. eine Entscheidung/Erfahrung extrahiert und gespeichert werden — die
Ausgabe listet die angelegten Einträge.

### Wie die Extraktion das LLM nutzt

Bei aktivem LLM werden pro Text **beide** Quellen kombiniert: die Marker-
Heuristik **und** die LLM-Extraktion. Die Ergebnisse werden über die stabile ID
dedupliziert — das LLM fügt also nur zusätzliche Abdeckung hinzu, überschreibt
aber nichts. So bleibt das Verhalten ohne LLM unverändert deterministisch.
