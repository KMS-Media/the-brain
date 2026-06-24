/**
 * UserPromptSubmit hook (PRD §19: "Retrieval vor jedem Prompt").
 *
 * Claude Code invokes this with a JSON payload on stdin:
 *   { "prompt": "...", "cwd": "...", "session_id": "..." }
 *
 * We retrieve relevant project memory and print it to stdout. For
 * UserPromptSubmit, Claude Code adds the hook's stdout to the prompt context.
 * On any error we stay silent (exit 0, no output) so the hook can never block
 * the user's prompt.
 */
import { Memory } from "../core.js";

const MIN_PROMPT_LEN = 8;

async function readStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  let payload: { prompt?: string; cwd?: string } = {};
  try {
    const raw = await readStdin();
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return; // malformed input → silent no-op
  }

  const prompt = (payload.prompt ?? "").trim();
  if (prompt.length < MIN_PROMPT_LEN) return;

  const mem = await Memory.open(payload.cwd);
  const ctx = await mem.context(prompt);
  mem.close();

  if (!ctx.markdown) return; // nothing relevant → inject nothing

  // For UserPromptSubmit, stdout is appended to the prompt context.
  process.stdout.write(ctx.markdown + "\n");
}

main().catch(() => {}).finally(() => process.exit(0));
