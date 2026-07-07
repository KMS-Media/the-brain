#!/usr/bin/env bash
# Interactive installer for the_brain — automates the steps documented in
# INSTALL.md (build, load into Claude Code, optional shared daemon). Every
# step that touches something outside this repo (shell rc, ~/.claude/settings.json,
# a launchd/systemd service) is behind an explicit y/N prompt; nothing outside
# this repo is changed silently. Safe to re-run — every step is idempotent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
info()  { printf '  %s\n' "$1"; }
warn()  { printf '\033[33m! %s\033[0m\n' "$1" >&2; }
die()   { printf '\033[31mError: %s\033[0m\n' "$1" >&2; exit 1; }
ask()   { read -rp "$1 " REPLY; [[ "$REPLY" =~ ^[Yy]$ ]]; }

bold "🧠 the_brain installer"
echo

# ---------------------------------------------------------------- Requirements
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node.js 20+ (https://nodejs.org) and re-run."
NODE_MAJOR="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node.js 20+ required (found $(node --version)). Upgrade and re-run."
fi
info "Node.js $(node --version) OK"

# ---------------------------------------------------------------- Build
bold "Installing dependencies and building..."
npm install
npm run build
info "Build complete (dist/)."
echo

# ---------------------------------------------------------------- Load into Claude Code
bold "How should the-brain be loaded into Claude Code?"
cat <<'MENU'
  1) --plugin-dir flag        (recommended: simplest, always finds this folder)
  2) Local marketplace install (persistent, no flag needed on every launch)
  3) Manual wiring             (register the MCP server + hooks yourself, scripted)
  4) Skip — I'll do this myself (see INSTALL.md)
MENU
read -rp "Choose [1-4]: " CHOICE
echo

case "$CHOICE" in
  1)
    ALIAS_LINE="alias claude-brain='claude --plugin-dir $ROOT'"
    RC_FILE="$HOME/.zshrc"
    [ -n "${ZSH_VERSION:-}" ] || [ "${SHELL:-}" = "/bin/zsh" ] || RC_FILE="$HOME/.bashrc"
    bold "Add this alias to your shell rc file so you don't have to type the flag every time:"
    info "$ALIAS_LINE"
    if ask "Append it to $RC_FILE now? [y/N]"; then
      printf '\n# the_brain plugin\n%s\n' "$ALIAS_LINE" >> "$RC_FILE"
      info "Added to $RC_FILE. Open a new shell, then run: claude-brain"
    else
      info "Skipped. Run manually: claude --plugin-dir $ROOT"
    fi
    ;;
  2)
    command -v claude >/dev/null 2>&1 || die "claude CLI not found on PATH."
    claude plugin marketplace add "$ROOT"
    claude plugin install "the_brain@the-brain-marketplace"
    info "Installed. After a git pull/npm update: npm run build && claude plugin marketplace update the-brain-marketplace"
    ;;
  3)
    command -v claude >/dev/null 2>&1 || die "claude CLI not found on PATH."
    claude mcp add the-brain -- node "$ROOT/dist/mcp/server.js"
    info "MCP server registered."
    if ask "Also add the UserPromptSubmit/Stop hooks to ~/.claude/settings.json (all projects)? [y/N]"; then
      node "$ROOT/scripts/merge-hooks.mjs" "$HOME/.claude/settings.json" "$ROOT"
    else
      info "Skipped — see INSTALL.md 'Way C' to add them manually (or to a single project's .claude/settings.json instead)."
    fi
    ;;
  *)
    info "Skipping Claude Code wiring — see INSTALL.md."
    ;;
esac
echo

# ---------------------------------------------------------------- Optional: shared daemon
bold "Optional: shared MCP daemon"
info "Lets multiple MCP clients (Claude Code, other tools, the CLI) share one"
info "project's memory without cross-process lock contention. See DEVELOPER.md"
info "'Optional: shared MCP daemon' for the full picture — this is experimental."
if ask "Set it up as a background service now? [y/N]"; then
  read -rp "Absolute path to the project this daemon should serve [$PWD]: " PROJECT_DIR
  PROJECT_DIR="${PROJECT_DIR:-$PWD}"
  [ -d "$PROJECT_DIR" ] || die "$PROJECT_DIR does not exist."
  NODE_BIN="$(command -v node)"
  OS="$(uname -s)"

  if [ "$OS" = "Darwin" ]; then
    PLIST="$HOME/Library/LaunchAgents/com.the-brain.daemon.plist"
    LOG_DIR="$HOME/Library/Logs"
    mkdir -p "$LOG_DIR"
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.the-brain.daemon</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>$ROOT/dist/mcp/daemon.js</string></array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key><dict><key>BRAIN_PROJECT_LOCAL</key><string>1</string></dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$LOG_DIR/the-brain-daemon.log</string>
  <key>StandardOutPath</key><string>$LOG_DIR/the-brain-daemon.log</string>
</dict></plist>
PLIST_EOF
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    launchctl load "$PLIST"
    info "Daemon installed and started (launchd). Logs: $LOG_DIR/the-brain-daemon.log"
  elif [ "$OS" = "Linux" ]; then
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    UNIT="$UNIT_DIR/the-brain-daemon.service"
    cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=the-brain shared MCP daemon

[Service]
ExecStart=$NODE_BIN $ROOT/dist/mcp/daemon.js
WorkingDirectory=$PROJECT_DIR
Environment=BRAIN_PROJECT_LOCAL=1
Restart=always

[Install]
WantedBy=default.target
UNIT_EOF
    systemctl --user daemon-reload
    systemctl --user enable --now the-brain-daemon.service
    info "Daemon installed and started (systemd --user). Logs: journalctl --user -u the-brain-daemon -f"
  else
    warn "No automatic service setup for OS '$OS'. See DEVELOPER.md for manual launchd/systemd examples."
  fi

  info "Now point each client's MCP config at the shim instead of the direct server:"
  info "  node $ROOT/dist/mcp/shim.js"
else
  info "Skipped. Set this up later — see DEVELOPER.md 'Optional: shared MCP daemon'."
fi
echo

# ---------------------------------------------------------------- Done
bold "Done."
cat <<EOF
Next steps:
  1. (Re)start Claude Code.
  2. Run /mcp inside Claude Code — the-brain should show as connected.
  3. node dist/bin/brain.js ingest   # scan this project into memory
See README.md and WORKFLOW.md for day-to-day usage, DEVELOPER.md for internals.
EOF
