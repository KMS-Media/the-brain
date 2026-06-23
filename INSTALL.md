# 🧠 the_brain — Installation & Einrichtung für Claude Code

Eine Schritt-für-Schritt-Anleitung, um das Plugin lokal zu installieren und in
Claude Code zu aktivieren. Alles läuft auf deinem Rechner — keine Cloud, keine
Accounts.

---

## Voraussetzungen

- **Node.js 20 oder neuer** — prüfen mit `node --version`
- **Claude Code** (aktuell; das Plugin-System braucht eine neuere Version — falls
  der Befehl `/plugin` fehlt, Claude Code aktualisieren)
- **git**

---

## Schritt 1 — Holen und bauen

```bash
git clone https://github.com/KMS-Media/the-brain.git
cd the-brain
npm install
npm run build
```

- `npm install` lädt die Abhängigkeiten (inkl. der lokalen Graph-DB und der
  Embedding-Bibliothek). Falls dein npm Installations-Skripte blockiert, einmal
  bestätigen, damit die nativen Komponenten gebaut werden.
- `npm run build` erzeugt den Ordner `dist/` — den braucht das Plugin zur
  Laufzeit.
- Beim allerersten Start wird einmalig ein kleines Embedding-Modell (~30 MB)
  heruntergeladen und zwischengespeichert; danach arbeitet alles offline.

> Merke dir den absoluten Pfad zum Ordner — du brauchst ihn gleich:
> ```bash
> pwd     # z. B. /Users/du/projects/the-brain
> ```

---

## Schritt 2 — In Claude Code laden

Es gibt drei Wege. **Weg A ist für dieses Plugin am robustesten** (es lädt direkt
aus dem Ordner; die nativen Abhängigkeiten und `dist/` werden zuverlässig
gefunden).

### Weg A — direkt laden mit `--plugin-dir` (empfohlen)

Starte Claude Code mit dem Pfad zum Plugin:

```bash
claude --plugin-dir /absoluter/pfad/zu/the-brain
```

Das war's — Hook (Kontext vor jedem Prompt) und MCP-Server (Memory-Tools) sind
aktiv. Damit du die Flagge nicht jedes Mal tippen musst, lege dir einen Alias an:

```bash
# in ~/.zshrc bzw. ~/.bashrc
alias claude-brain='claude --plugin-dir /absoluter/pfad/zu/the-brain'
```

Nach Änderungen am Plugin im laufenden Claude Code: `/reload-plugins`.

### Weg B — als lokaler Marketplace installieren (persistent)

So bleibt das Plugin dauerhaft installiert, ohne Start-Flagge:

```text
/plugin marketplace add /absoluter/pfad/zu/the-brain
/plugin install the_brain@the-brain-marketplace
```

> Hinweis: Beim Installieren kopiert Claude Code den Plugin-Ordner in einen
> Cache. Führe deshalb **vorher** `npm install` **und** `npm run build` aus.
> Nach einem `git pull` / `npm update`: erneut bauen und
> `/plugin marketplace update the-brain-marketplace` ausführen.

### Weg C — manuell einrichten (volle Kontrolle, kein Plugin-System)

Wenn du MCP-Server und Hook lieber selbst in deine Einstellungen einträgst:

**1. MCP-Server registrieren** (absoluter Pfad zu `dist/mcp/server.js`):

```bash
claude mcp add the-brain -- node /absoluter/pfad/zu/the-brain/dist/mcp/server.js
```

**2. Hooks eintragen** in `~/.claude/settings.json` (für alle Projekte) oder
`<projekt>/.claude/settings.json` (nur dieses Projekt) — **absolute Pfade**:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node /absoluter/pfad/zu/the-brain/dist/hooks/inject.js", "timeout": 30 }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node /absoluter/pfad/zu/the-brain/dist/hooks/learn.js", "timeout": 30 }
        ]
      }
    ]
  }
}
```

> Bei Weg C **absolute Pfade** verwenden — die Variable `${CLAUDE_PLUGIN_ROOT}`
> (wie in den mitgelieferten Konfigs) wird nur im Plugin-Kontext (Weg A/B)
> aufgelöst.

Danach Claude Code neu starten.

---

## Schritt 3 — Prüfen, ob es läuft

In Claude Code:

```text
/plugin     →  the-brain sollte als aktiviert erscheinen (Weg B)
/mcp        →  der Server "the-brain" sollte "connected" sein
```

Schneller Funktionstest im Terminal (im Plugin-Ordner):

```bash
node dist/bin/brain.js init
node dist/bin/brain.js learn "DECISION: Use PostgreSQL | chosen for JSONB support"
node dist/bin/brain.js query "which database did we choose?"
```

Die letzte Zeile sollte deine Entscheidung als Kontextblock zurückgeben.

---

## Schritt 4 — Loslegen

1. Öffne dein Projekt in Claude Code (mit aktivem Plugin).
2. Einmalig das Projekt einlesen (Struktur + Git-Historie ins Gedächtnis):
   ```bash
   node dist/bin/brain.js ingest
   ```
3. Arbeite normal. the_brain blendet vor jedem Prompt relevantes Wissen ein und
   lernt aus Claudes Antworten dazu (Marker wie `DECISION:`, `FINDING[high]:`,
   `LEARNED:`, `RULE:`, `NOTE:`).

Mehr Befehle und Optionen: [README.md](./README.md). Architektur & Interna:
[DEVELOPER.md](./DEVELOPER.md).

---

## Troubleshooting

| Problem | Lösung |
| --- | --- |
| `/plugin` gibt es nicht | Claude Code aktualisieren |
| `/mcp` zeigt the-brain nicht | `npm run build` ausgeführt? Claude Code neu starten / `/reload-plugins` |
| `node: command not found` oder alte Version | Node.js 20+ installieren |
| Erster Aufruf langsam | Einmaliger Modell-Download; danach schnell. Mit `BRAIN_OFFLINE=1` spätere Downloads verbieten |
| Installationsskripte blockiert | Skripte für `kuzu`, `onnxruntime-node`, `sharp` zulassen und `npm install` wiederholen |
| Nach Update startet MCP nicht (Weg B) | Neu bauen + `/plugin marketplace update the-brain-marketplace` |

---

## Deinstallieren

- **Weg A:** einfach ohne `--plugin-dir` starten.
- **Weg B:** `/plugin uninstall the_brain@the-brain-marketplace`
- **Weg C:** `claude mcp remove the-brain` und den Hook-Block aus `settings.json` entfernen.
- **Daten löschen:** den Projektordner unter `~/.claude-memory/` entfernen.
