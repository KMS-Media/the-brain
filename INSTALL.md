# 🧠 the_brain — Installation & Setup for Claude Code

A step-by-step guide to installing the plugin locally and enabling it in Claude
Code. Everything runs on your own machine — no cloud, no accounts.

---

## Requirements

- **Node.js 20 or newer** — check with `node --version`
- **Claude Code** (recent; the plugin system needs a newer version — if the
  `/plugin` command is missing, update Claude Code)
- **git**

---

## Step 1 — Get it and build

```bash
git clone https://github.com/KMS-Media/the-brain.git
cd the-brain
npm install
npm run build
```

- `npm install` fetches the dependencies (including the local graph database and
  the embedding library). If your npm blocks install scripts, approve them once
  so the native components get built.
- `npm run build` produces the `dist/` folder — the plugin needs it at runtime.
- On the very first run a small embedding model (~30 MB) is downloaded once and
  cached; after that everything works offline.

> Note the absolute path to the folder — you'll need it in a moment:
> ```bash
> pwd     # e.g. /Users/you/projects/the-brain
> ```

---

## Step 2 — Load it into Claude Code

There are three ways. **Way A is the most robust for this plugin** (it loads
straight from the folder, so the native dependencies and `dist/` are always
found).

### Way A — load directly with `--plugin-dir` (recommended)

Start Claude Code with the path to the plugin:

```bash
claude --plugin-dir /absolute/path/to/the-brain
```

That's it — the hook (context before every prompt) and the MCP server (memory
tools) are active. So you don't have to type the flag every time, add an alias:

```bash
# in ~/.zshrc or ~/.bashrc
alias claude-brain='claude --plugin-dir /absolute/path/to/the-brain'
```

After changing the plugin while Claude Code is running: `/reload-plugins`.

### Way B — install as a local marketplace (persistent)

This keeps the plugin installed permanently, without a startup flag:

```text
/plugin marketplace add /absolute/path/to/the-brain
/plugin install the_brain@the-brain-marketplace
```

> Note: on install, Claude Code copies the plugin folder into a cache. So run
> `npm install` **and** `npm run build` **first**. After a `git pull` /
> `npm update`: rebuild and run
> `/plugin marketplace update the-brain-marketplace`.

### Way C — wire it up manually (full control, no plugin system)

If you'd rather register the MCP server and hook in your own settings:

**1. Register the MCP server** (absolute path to `dist/mcp/server.js`):

```bash
claude mcp add the-brain -- node /absolute/path/to/the-brain/dist/mcp/server.js
```

**2. Add the hooks** in `~/.claude/settings.json` (all projects) or
`<project>/.claude/settings.json` (this project only) — use **absolute paths**:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node /absolute/path/to/the-brain/dist/hooks/inject.js", "timeout": 30 }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node /absolute/path/to/the-brain/dist/hooks/learn.js", "timeout": 30 }
        ]
      }
    ]
  }
}
```

> With Way C use **absolute paths** — the `${CLAUDE_PLUGIN_ROOT}` variable (as
> used in the bundled configs) is only resolved in plugin context (Way A/B).

Then restart Claude Code.

---

## Step 3 — Verify it's working

In Claude Code:

```text
/plugin     →  the_brain should appear as enabled (Way B)
/mcp        →  the "the-brain" server should be "connected"
```

Quick functional test in the terminal (inside the plugin folder):

```bash
node dist/bin/brain.js init
node dist/bin/brain.js learn "DECISION: Use PostgreSQL | chosen for JSONB support"
node dist/bin/brain.js query "which database did we choose?"
```

The last line should return your decision as a context block.

---

## Step 4 — Get going

1. Open your project in Claude Code (with the plugin enabled).
2. Ingest the project once (structure + git history into memory):
   ```bash
   node dist/bin/brain.js ingest
   ```
3. Work as usual. the_brain surfaces relevant knowledge before every prompt and
   learns from Claude's answers (markers like `DECISION:`, `FINDING[high]:`,
   `LEARNED:`, `RULE:`, `NOTE:`).

More commands and options: [README.md](./README.md). Architecture & internals:
[DEVELOPER.md](./DEVELOPER.md).

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `/plugin` doesn't exist | Update Claude Code |
| `/mcp` doesn't show the-brain | Did you run `npm run build`? Restart Claude Code / `/reload-plugins` |
| `node: command not found` or old version | Install Node.js 20+ |
| First call is slow | One-time model download; fast afterwards. Use `BRAIN_OFFLINE=1` to forbid later downloads |
| Install scripts blocked | Allow scripts for `kuzu`, `onnxruntime-node`, `sharp` and re-run `npm install` |
| MCP doesn't start after an update (Way B) | Rebuild + `/plugin marketplace update the-brain-marketplace` |

---

## Uninstalling

- **Way A:** just start without `--plugin-dir`.
- **Way B:** `/plugin uninstall the_brain@the-brain-marketplace`
- **Way C:** `claude mcp remove the-brain` and remove the hook block from `settings.json`.
- **Delete the data:** remove the project folder under `~/.claude-memory/`.
