import type { Memory } from "../core.js";
import type { NodeLabel } from "../types.js";

/**
 * Automatic learning (PRD §14): scan a block of text (typically a Claude
 * response or a review summary) for structured knowledge worth persisting,
 * and write it into the graph.
 *
 * This is a deterministic, heuristic extractor (no LLM call) for the MVP — it
 * recognizes explicit markers that Claude or a reviewer can emit. The same
 * Memory facade is used to store results so embeddings/relationships are
 * handled uniformly.
 */

export interface ExtractedItem {
  label: NodeLabel;
  props: Record<string, unknown>;
}

/** Marker patterns. Each captures a single-line declaration. */
const PATTERNS: { label: NodeLabel; re: RegExp; build: (m: RegExpMatchArray) => Record<string, unknown> }[] = [
  {
    label: "Decision",
    re: /^\s*(?:ADR|DECISION|ENTSCHEIDUNG)\s*:\s*(.+?)(?:\s*\|\s*(.+))?$/gim,
    build: (m) => ({ title: m[1].trim(), decision: (m[2] ?? m[1]).trim(), date: new Date().toISOString().slice(0, 10) }),
  },
  {
    label: "ReviewFinding",
    re: /^\s*(?:FINDING|REVIEW|BEFUND)\s*(?:\[(\w+)\])?\s*:\s*(.+?)(?:\s*->\s*(.+))?$/gim,
    build: (m) => ({ severity: (m[1] ?? "medium").toLowerCase(), rule: m[2].trim(), fix: m[3]?.trim(), frequency: 1 }),
  },
  {
    label: "Experience",
    re: /^\s*(?:LEARNED|EXPERIENCE|ERFAHRUNG)\s*:\s*(.+?)\s*->\s*(.+)$/gim,
    build: (m) => ({ problem: m[1].trim(), solution: m[2].trim(), confidence: 0.6 }),
  },
  {
    label: "CodingStandard",
    re: /^\s*(?:RULE|STANDARD|REGEL)\s*:\s*(.+?)(?:\s*\|\s*(.+))?$/gim,
    build: (m) => ({ name: m[1].trim(), description: (m[2] ?? m[1]).trim() }),
  },
  {
    label: "Knowledge",
    re: /^\s*(?:NOTE|KNOWLEDGE|WISSEN)\s*:\s*(.+?)(?:\s*\|\s*(.+))?$/gim,
    build: (m) => ({ title: m[1].trim().slice(0, 80), content: (m[2] ?? m[1]).trim() }),
  },
];

/** Parse text into structured items without writing anything. */
export function extract(text: string): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  for (const { label, re, build } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const props = build(m);
      if (Object.values(props).some((v) => typeof v === "string" && v.length > 0)) {
        items.push({ label, props });
      }
    }
  }
  return items;
}

/** Extract and persist; returns the ids of created/updated nodes. */
export async function learn(memory: Memory, text: string): Promise<{ label: NodeLabel; id: string }[]> {
  const items = extract(text);
  const created: { label: NodeLabel; id: string }[] = [];
  for (const item of items) {
    const { id } = await memory.repo.upsertNode(item.label, item.props);
    created.push({ label: item.label, id });
  }
  return created;
}
