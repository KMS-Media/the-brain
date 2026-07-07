#!/usr/bin/env node
// Idempotently merges the-brain's UserPromptSubmit/Stop hooks into an existing
// Claude Code settings.json without touching anything else already there.
// Used by scripts/install.sh (Way C: manual wiring) — kept as a separate,
// reviewable script rather than inline shell+sed/jq so the JSON merge stays
// correct regardless of what's already in the user's settings file.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";

const [, , settingsPath, rootDir] = process.argv;
if (!settingsPath || !rootDir) {
  console.error("usage: merge-hooks.mjs <settings.json path> <the_brain root>");
  process.exit(1);
}

const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
settings.hooks ??= {};

function addHook(event, command) {
  const entries = (settings.hooks[event] ??= []);
  const alreadyPresent = entries.some((entry) => (entry.hooks ?? []).some((h) => h.command === command));
  if (alreadyPresent) return false;
  entries.push({ matcher: "*", hooks: [{ type: "command", command, timeout: 30 }] });
  return true;
}

const injectAdded = addHook("UserPromptSubmit", `node ${rootDir}/dist/hooks/inject.js`);
const learnAdded = addHook("Stop", `node ${rootDir}/dist/hooks/learn.js`);

if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.bak`);
mkdirSync(dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

console.log(`UserPromptSubmit hook: ${injectAdded ? "added" : "already present"}`);
console.log(`Stop hook: ${learnAdded ? "added" : "already present"}`);
if (existsSync(`${settingsPath}.bak`)) console.log(`Backup written to ${settingsPath}.bak`);
