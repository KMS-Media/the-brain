# 🧠 the_brain

**A long-term memory for Claude Code.** It remembers your project's decisions,
review findings, coding standards and hard-won lessons — and quietly reminds
Claude of the relevant ones before every prompt, so you stop re-explaining the
same context and Claude stops repeating the same mistakes.

Everything runs **100% on your machine**. No cloud, no accounts, no telemetry —
your code and knowledge never leave your computer.

---

## What you get

- 🧠 **Persistent project memory** — knowledge survives across sessions.
- ⚠️ **Fewer repeated mistakes** — past review findings are surfaced first.
- 🏛️ **Decisions stick** — architecture choices (ADRs) are never forgotten.
- ✂️ **Less typing** — relevant context is injected automatically, within a token budget.
- 🔒 **Private by design** — local embeddings, local database, optional encrypted backups.

---

## Requirements

- **Node.js 20 or newer** (`node --version`)
- **Claude Code**
- macOS, Linux, or Windows

---

## Install

```bash
# 1. Get the plugin
git clone https://github.com/KMS-Media/the-brain.git
cd the-brain

# 2. Install and build
npm install
npm run build
```

The first run downloads a small embedding model (~30 MB) once and caches it
locally. After that it works fully offline.

### Add it to Claude Code

This repo is a ready-made Claude Code plugin. The quickest way to load it:

```bash
claude --plugin-dir /absolute/path/to/the-brain
```

You then get both **automatic context** before every prompt (via the included
hook) and **memory tools** Claude can call (via the included MCP server). Run
`/mcp` to confirm the **the-brain** server is connected.

> 📖 **Full step-by-step setup — including a permanent install, manual wiring,
> verification and troubleshooting — is in [INSTALL.md](./INSTALL.md).**
>
> Want to know how it works under the hood? See [DEVELOPER.md](./DEVELOPER.md).

---

## Using it

Most of the time you don't do anything — the_brain works in the background:
it loads relevant memory before each prompt and learns from Claude's answers.

You can also drive it directly from the terminal:

```bash
# Get up to speed on a project (scan files + git history into memory)
node dist/bin/brain.js ingest

# Ask what the project memory knows about something
node dist/bin/brain.js query "how does authentication work?"

# Teach it something explicitly
node dist/bin/brain.js learn "DECISION: Use PostgreSQL | chosen for JSONB support"

# See your knowledge as an interactive graph (opens an HTML file)
node dist/bin/brain.js explore graph.html
```

Run `node dist/bin/brain.js` with no arguments to see every command.

### Teaching it in plain text

When you (or Claude) write a line starting with one of these markers, the_brain
captures it automatically:

| Write this… | …and it remembers a |
|---|---|
| `DECISION: <title> \| <details>` | architecture decision |
| `FINDING[high]: <problem> -> <fix>` | code review finding |
| `LEARNED: <problem> -> <solution>` | lesson / experience |
| `RULE: <name> \| <description>` | coding standard |
| `NOTE: <title> \| <content>` | general knowledge |

---

## Optional extras

- **Encrypted backups** — set a passphrase and your backups are encrypted:
  ```bash
  export BRAIN_BACKUP_KEY="your secret passphrase"
  node dist/bin/brain.js backup
  node dist/bin/brain.js restore <backup-file>
  ```
- **Share with a teammate** — export a portable bundle they can merge into their
  own local memory (no server involved):
  ```bash
  node dist/bin/brain.js share export team.brainshare   # you
  node dist/bin/brain.js share import team.brainshare   # them
  ```
- **Pull in GitHub issues & PRs** (needs the [`gh`](https://cli.github.com) CLI):
  ```bash
  node dist/bin/brain.js github
  ```
- **VS Code** — a companion extension lives in [`extension/`](./extension/README.md).
- **Use your own local LLM** (e.g. [Ollama](https://ollama.com)) for richer
  knowledge extraction — set `BRAIN_LLM_URL=http://localhost:11434/v1`.

---

## Where your data lives

| | Location |
|---|---|
| Memory database | `~/.claude-memory/<project>/` |
| Embedding model cache | `~/.claude-memory/models/` |

To start fresh, delete the project's folder under `~/.claude-memory/`. To keep a
project's memory inside the project instead, set `BRAIN_PROJECT_LOCAL=1` (it then
lives in `./.project-memory/`).

---

## Privacy

the_brain is fully local: local embeddings, a local embedded database, and no
network calls except the one-time model download (which you can disable with
`BRAIN_OFFLINE=1` afterwards). Nothing is ever sent to a server.

---

## Troubleshooting

- **`/mcp` doesn't show the-brain** — make sure you ran `npm run build` and
  restarted Claude Code.
- **First command is slow** — that's the one-time model download; later runs are fast.
- **`node: command not found` / old Node** — install Node.js 20+.

---

## License & contributing

See [DEVELOPER.md](./DEVELOPER.md) for architecture, the full command reference,
configuration options, and how to build on the plugin.
