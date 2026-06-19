import type { NodeLabel } from "../types.js";

/**
 * Intent Analysis (PRD §9, the pipeline step before embedding).
 *
 * A deterministic, no-LLM classifier: it scans the prompt for signals about
 * which kinds of memory matter most for this task, and returns
 *  - `focus`: labels the prompt is about (these get more retrieval breadth)
 *  - `boost`: a small additive score nudge per focused label
 *
 * The boost is intentionally small so the §10 semantic-first ranking still
 * dominates; intent only breaks ties toward the relevant kind of knowledge.
 */

export interface Intent {
  focus: NodeLabel[];
  boost: Partial<Record<NodeLabel, number>>;
}

const BOOST = 0.08;

const SIGNALS: { label: NodeLabel; re: RegExp }[] = [
  {
    label: "ReviewFinding",
    re: /\b(review|bug|fix(?:ing|ed)?|error|issue|vulnerab\w*|security|secret|inject\w*|lint|broken|fail\w*|regression|crash|leak|fehler|sicherheit)\b/i,
  },
  {
    label: "Decision",
    re: /\b(architect\w*|design|decide|decision|adr|trade-?offs?|choose|chosen|approach|rationale|why (?:do|did|we|is)|entscheid\w*|architektur)\b/i,
  },
  {
    label: "CodingStandard",
    re: /\b(convention|standard|style|format(?:ting)?|naming|guideline|best practice|rule|regel|konvention|richtlinie)\b/i,
  },
  {
    label: "Experience",
    re: /\b(last time|before|previously|already|how did we|learned|experience|gotcha|pitfall|workaround|erfahrung|schon mal|damals)\b/i,
  },
  {
    label: "Component",
    re: /\b(component|service|module|micro-?service|api|endpoint|worker|library|package|depend\w*|integrat\w*|komponente|dienst|modul)\b/i,
  },
  {
    label: "Knowledge",
    re: /\b(what is|explain|overview|how does|background|context|document\w*|wissen|erklär\w*|überblick)\b/i,
  },
];

export function analyzeIntent(query: string): Intent {
  const focus: NodeLabel[] = [];
  const boost: Partial<Record<NodeLabel, number>> = {};
  for (const { label, re } of SIGNALS) {
    if (re.test(query)) {
      focus.push(label);
      boost[label] = BOOST;
    }
  }
  return { focus, boost };
}
