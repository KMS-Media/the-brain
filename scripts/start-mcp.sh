#!/bin/sh
# Locate the plugin root regardless of whether we run from cache or source.
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KUZU_DIR="$PLUGIN_ROOT/node_modules/kuzu"

# Kuzu's postinstall (install.js) copies the prebuilt .node binary and
# generates the JS wrapper files (index.mjs, index.js, etc.).
# When Claude Code caches a plugin it skips postinstall, so we self-heal here.
if [ ! -f "$KUZU_DIR/kuzujs.node" ]; then
  echo "the-brain: initialising kuzu native binary..." >&2
  node "$KUZU_DIR/install.js" >&2
fi

exec node "$PLUGIN_ROOT/dist/mcp/server.js"
