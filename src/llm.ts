import { llmConfig } from "./config.js";
import type { NodeLabel } from "./types.js";

/**
 * Optional local LLM integration (PRD §21 V2).
 *
 * Talks to a local OpenAI-compatible chat endpoint (Ollama, llama.cpp, …). Used
 * to enrich knowledge extraction beyond the regex markers. Everything degrades
 * gracefully: if no endpoint is configured (or it errors), callers fall back to
 * the deterministic heuristics, so the LLM is a pure enhancement and never a
 * hard dependency.
 */

export function isLLMEnabled(): boolean {
  return llmConfig() !== null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Send a chat completion to the local endpoint. Throws if not configured. */
export async function chat(messages: ChatMessage[], opts: { temperature?: number; timeoutMs?: number } = {}): Promise<string> {
  const cfg = llmConfig();
  if (!cfg) throw new Error("No local LLM configured (set BRAIN_LLM_URL).");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: opts.temperature ?? 0.1,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

export interface LLMExtractedItem {
  label: NodeLabel;
  props: Record<string, unknown>;
}

const VALID_LABELS: NodeLabel[] = ["Decision", "ReviewFinding", "Experience", "CodingStandard", "Knowledge", "Problem"];

const SYSTEM_PROMPT = `You extract durable project knowledge from text for a long-term memory system.
Return ONLY a JSON array (no prose) of items. Each item is one of:
{"type":"Decision","title":"...","decision":"...","reasoning":"..."}
{"type":"ReviewFinding","rule":"...","severity":"high|medium|low","fix":"..."}
{"type":"Experience","problem":"...","solution":"...","outcome":"..."}
{"type":"CodingStandard","name":"...","description":"..."}
{"type":"Knowledge","title":"...","content":"..."}
{"type":"Problem","title":"...","description":"..."}
Only extract genuinely reusable knowledge (architecture decisions, review findings, lessons, rules, key facts). If nothing qualifies, return [].`;

/** Extract a JSON array from a possibly-fenced LLM response. */
function parseJsonArray(text: string): unknown[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Use the local LLM to extract structured knowledge from free text. Returns []
 * if the LLM is disabled, errors, or finds nothing — callers should merge this
 * with the regex extractor's output.
 */
export async function extractWithLLM(text: string): Promise<LLMExtractedItem[]> {
  if (!isLLMEnabled() || !text.trim()) return [];
  let raw: string;
  try {
    raw = await chat([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text.slice(0, 8000) },
    ]);
  } catch {
    return [];
  }
  const items: LLMExtractedItem[] = [];
  for (const entry of parseJsonArray(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const label = String(e.type) as NodeLabel;
    if (!VALID_LABELS.includes(label)) continue;
    const { type: _t, ...props } = e;
    // Require at least one non-empty string field.
    if (Object.values(props).some((v) => typeof v === "string" && v.trim().length > 0)) {
      items.push({ label, props });
    }
  }
  return items;
}
