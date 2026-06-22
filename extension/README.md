# the_brain — VS Code Extension

A thin VS Code client for the local [`the_brain`](../README.md) memory plugin.
It shells out to the `brain` CLI in your workspace folder, so all data stays
local.

## Commands

| Command | Action |
|---|---|
| **the_brain: Search Memory** | Prompt for a query and show the assembled context block |
| **the_brain: Context for Current File** | Show memory relevant to the active file |
| **the_brain: Ingest Repository** | Scan repo structure + git history into the graph |
| **the_brain: Curate Memory** | Run the maintenance agent (consolidate + promote findings) |
| **the_brain: Open Graph Explorer** | Open the interactive knowledge graph in a webview |

## Setup

```bash
cd extension
npm install
npm run compile      # → out/extension.js
```

Press **F5** in VS Code to launch an Extension Development Host, or package with
`vsce package`.

## Configuration

- `theBrain.cli` (default `brain`): command used to invoke the CLI. If `the_brain`
  isn't installed globally, set it to e.g. `node /abs/path/the_brain/dist/bin/brain.js`.
