import type { MemoryContext, NodeLabel, ScoredNode } from "../types.js";
import { CONTEXT_TOKEN_BUDGET } from "../config.js";

/**
 * Context Builder (PRD §12): deduplicate, prioritize, summarize, and keep
 * within a token budget. Priority order (PRD §11):
 *   1. Review Findings  2. Coding Standards  3. Decisions
 *   4. Architecture (Components)  5. Experiences  6. Knowledge
 */

const PRIORITY: NodeLabel[] = [
  "ReviewFinding",
  "CodingStandard",
  "Decision",
  "Component",
  "Experience",
  "Knowledge",
  "Problem",
];

/** Word-set Jaccard above this counts two rendered lines as the same insight. */
const SIMILARITY_THRESHOLD = 0.6;

/** ~4 chars per token heuristic for budget enforcement. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Normalized set of significant words (drops punctuation and 1-char tokens). */
function wordSet(line: string): Set<string> {
  return new Set(
    line
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** One-line rendering of a node for the context block. */
function renderLine(n: ScoredNode): string {
  const p = n.props;
  const s = (v: unknown) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
  switch (n.label) {
    case "ReviewFinding":
      return `[${s(p.severity) || "finding"}] ${s(p.rule)}${p.fix ? ` → Fix: ${s(p.fix)}` : ""}`;
    case "CodingStandard":
      return `${s(p.name)}: ${s(p.description)}`;
    case "Decision":
      return `${s(p.title)}: ${s(p.decision)}${p.reasoning ? ` (weil: ${s(p.reasoning)})` : ""}`;
    case "Component":
      return `${s(p.name)}${p.type ? ` (${s(p.type)})` : ""}${p.description ? ` — ${s(p.description)}` : ""}`;
    case "Experience":
      return `Problem: ${s(p.problem)} → Lösung: ${s(p.solution)}${p.outcome ? ` (${s(p.outcome)})` : ""}`;
    case "Problem":
      return `${s(p.title)}${p.description ? `: ${s(p.description)}` : ""}`;
    case "Knowledge":
      return `${s(p.title)}: ${s(p.content)}`;
    default:
      return s(p.title) || s(p.name) || s(p.id);
  }
}

const SECTION_TITLES: Record<string, string> = {
  ReviewFinding: "⚠️ Review Findings (vermeide diese Fehler erneut)",
  CodingStandard: "📐 Coding Standards",
  Decision: "🏛️ Architekturentscheidungen (ADRs)",
  Component: "🧩 Architektur / Komponenten",
  Experience: "💡 Erfahrungen",
  Knowledge: "📚 Projektwissen",
  Problem: "❗ Bekannte Probleme",
};

export interface BuildResult {
  context: MemoryContext;
  /** Ids actually included (for usage bumping). */
  used: { label: NodeLabel; id: string }[];
}

export function buildContext(query: string, ranked: ScoredNode[], tokenBudget = CONTEXT_TOKEN_BUDGET): BuildResult {
  // 1. Merge similar findings (PRD §12). `ranked` is sorted by score desc, so
  //    we keep the highest-scored item and drop later ones whose rendered line
  //    is near-identical (word-set Jaccard ≥ threshold) within the same label.
  //    This catches re-phrasings ("missing input validation" vs "input
  //    validation is missing") that exact-string dedup would miss.
  const kept: { node: ScoredNode; tokens: Set<string> }[] = [];
  for (const n of ranked) {
    const line = renderLine(n);
    if (!line.trim()) continue;
    const tokens = wordSet(line);
    const dup = kept.some((k) => k.node.label === n.label && jaccard(k.tokens, tokens) >= SIMILARITY_THRESHOLD);
    if (dup) continue;
    kept.push({ node: n, tokens });
  }
  const deduped = kept.map((k) => k.node);

  // 2. Group by label, then walk in priority order; enforce token budget.
  const grouped = new Map<NodeLabel, ScoredNode[]>();
  for (const n of deduped) {
    const arr = grouped.get(n.label) ?? [];
    arr.push(n);
    grouped.set(n.label, arr);
  }

  const sections: Record<string, string[]> = {};
  const used: { label: NodeLabel; id: string }[] = [];
  let budget = tokenBudget;

  for (const label of PRIORITY) {
    const nodes = grouped.get(label);
    if (!nodes || nodes.length === 0) continue;
    nodes.sort((a, b) => b.score - a.score);
    const lines: string[] = [];
    for (const n of nodes) {
      const line = renderLine(n);
      const cost = estimateTokens(line) + 2;
      if (cost > budget) continue; // skip this one, try smaller later items
      budget -= cost;
      lines.push(line);
      used.push({ label, id: n.id });
    }
    if (lines.length) sections[label] = lines;
    if (budget <= 0) break;
  }

  // 3. Assemble structured context + markdown.
  const get = (label: NodeLabel) => sections[label] ?? [];
  const markdown = renderMarkdown(query, sections);

  const context: MemoryContext = {
    summary: summarize(sections),
    findings: get("ReviewFinding"),
    standards: get("CodingStandard"),
    decisions: get("Decision"),
    architecture: get("Component"),
    experiences: get("Experience"),
    knowledge: [...get("Knowledge"), ...get("Problem")],
    markdown,
  };
  return { context, used };
}

function summarize(sections: Record<string, string[]>): string {
  const counts = Object.entries(sections)
    .map(([label, lines]) => `${lines.length} ${SECTION_TITLES[label]?.replace(/^[^A-Za-zÄÖÜ]+/, "") ?? label}`)
    .join(", ");
  return counts ? `Relevantes Projektgedächtnis: ${counts}.` : "Kein relevantes Projektgedächtnis gefunden.";
}

function renderMarkdown(query: string, sections: Record<string, string[]>): string {
  const ordered = PRIORITY.filter((l) => sections[l]?.length);
  if (ordered.length === 0) return "";
  const parts: string[] = ["## 🧠 Projektgedächtnis", ""];
  for (const label of ordered) {
    parts.push(`### ${SECTION_TITLES[label] ?? label}`);
    for (const line of sections[label]) parts.push(`- ${line}`);
    parts.push("");
  }
  return parts.join("\n").trim();
}
