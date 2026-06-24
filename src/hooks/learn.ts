/**
 * Stop hook (PRD §14: "Nach jeder Claude-Antwort erfolgt Analyse").
 *
 * Claude Code invokes this when a response finishes, with a JSON payload on
 * stdin:
 *   { "transcript_path": "...", "cwd": "...", "stop_hook_active": bool, ... }
 *
 * We read the last assistant turn from the transcript and run the heuristic
 * extractor over it (ADR/FINDING/LEARNED/RULE/NOTE markers → graph nodes).
 * The extractor uses stable ids, so re-processing is idempotent. We never
 * block: any error or empty result exits 0 with no output.
 *
 * Performance: extraction is a cheap regex pass run BEFORE opening the DB or
 * loading the embedding model, so a normal answer with no markers costs almost
 * nothing.
 */
import { readFileSync } from "node:fs";
import { extract } from "../learning/extractor.js";

export interface StopPayload {
  transcript_path?: string;
  cwd?: string;
  stop_hook_active?: boolean;
}

async function readStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/** Extract the text of the most recent assistant message from a transcript JSONL. */
export function lastAssistantText(transcriptPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return "";
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const e = entry as { type?: string; message?: { role?: string; content?: unknown } };
    const isAssistant = e.type === "assistant" || e.message?.role === "assistant";
    if (!isAssistant) continue;
    const content = e.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
        .map((c) => (c as { text?: string }).text ?? "")
        .join("\n");
    }
  }
  return "";
}

/**
 * Core of the Stop hook, testable in-process. Returns the nodes learned (empty
 * when nothing was found, the loop guard fired, or no transcript was given).
 */
export async function handleStop(payload: StopPayload): Promise<{ label: string; id: string }[]> {
  if (payload.stop_hook_active) return []; // guard against re-entry loops
  if (!payload.transcript_path) return [];

  const text = lastAssistantText(payload.transcript_path);
  if (!text) return [];

  // Cheap pre-check: only touch the DB if there is something to learn.
  if (extract(text).length === 0) return [];

  const { Memory } = await import("../core.js");
  const { learn } = await import("../learning/extractor.js");
  const { isLLMEnabled } = await import("../llm.js");
  const mem = await Memory.open(payload.cwd);
  try {
    return await learn(mem, text, { useLLM: isLLMEnabled() });
  } finally {
    mem.close();
  }
}

async function main() {
  let payload: StopPayload = {};
  try {
    const raw = await readStdin();
    payload = raw ? (JSON.parse(raw) as StopPayload) : {};
  } catch {
    return;
  }
  await handleStop(payload);
}

// Only run as a hook when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {}).finally(() => process.exit(0));
}
