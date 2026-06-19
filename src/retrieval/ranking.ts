import type { ScoredNode } from "../types.js";

/**
 * Ranking weights (PRD §10):
 *   score = semantic*0.40 + graph*0.25 + importance*0.15 + usage*0.10 + recency*0.10
 * Each component is normalized to 0..1 before weighting.
 */
export const WEIGHTS = {
  semantic: 0.4,
  graph: 0.25,
  importance: 0.15,
  usage: 0.1,
  recency: 0.1,
} as const;

/** Raw signals gathered for a candidate before normalization. */
export interface Signals {
  semantic: number; // already 0..1 (cosine, clamped)
  graphConnections: number; // count of edges to other candidates
  importance: number; // 0..1
  usageCount: number; // raw count
  updatedAt?: string | Date; // timestamp (Kuzu returns Date)
}

/** Recency decay: 1.0 today, ~0.5 after `halfLifeDays`, asymptotically 0. */
export function recencyScore(updatedAt: string | Date | undefined, now: number, halfLifeDays = 30): number {
  if (!updatedAt) return 0.3; // unknown age → neutral-low
  let t: number;
  if (updatedAt instanceof Date) {
    t = updatedAt.getTime();
  } else {
    // Kuzu stores naive timestamps; treat them as UTC.
    t = Date.parse(updatedAt.endsWith("Z") ? updatedAt : updatedAt + "Z");
  }
  if (Number.isNaN(t)) return 0.3;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Normalize usage with a log curve so a few heavy hitters don't dominate. */
export function usageScore(usageCount: number, maxUsage: number): number {
  if (maxUsage <= 0) return 0;
  return Math.log1p(Math.max(0, usageCount)) / Math.log1p(maxUsage);
}

/**
 * Combine normalized signals into a final score. `maxConnections` and
 * `maxUsage` are dataset maxima used to normalize the graph and usage signals.
 */
export function combine(
  s: Signals,
  ctx: { now: number; maxConnections: number; maxUsage: number },
): ScoredNode["breakdown"] & { score: number } {
  const semantic = clamp01(s.semantic);
  const graph = ctx.maxConnections > 0 ? clamp01(s.graphConnections / ctx.maxConnections) : 0;
  const importance = clamp01(s.importance);
  const usage = usageScore(s.usageCount, ctx.maxUsage);
  const recency = clamp01(recencyScore(s.updatedAt, ctx.now));

  const score =
    semantic * WEIGHTS.semantic +
    graph * WEIGHTS.graph +
    importance * WEIGHTS.importance +
    usage * WEIGHTS.usage +
    recency * WEIGHTS.recency;

  return { semantic, graph, importance, usage, recency, score };
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
