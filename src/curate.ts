import { createHash } from "node:crypto";
import type { Memory } from "./core.js";
import { consolidate, type ConsolidationReport } from "./consolidate.js";

/**
 * Agent-based knowledge curation (PRD §21 V2).
 *
 * An automated maintenance "agent" that keeps the graph healthy and makes
 * quality rise over time (PRD §20.6/§20.7). It runs a deterministic pipeline:
 *   1. consolidate  — merge semantically duplicate knowledge.
 *   2. promote      — recurring review findings (frequency ≥ N) become coding
 *                     standards, linked VIOLATES, so repeated mistakes harden
 *                     into rules.
 *   3. prune (opt-in) — drop stale, unused, low-importance knowledge.
 * Intended to be run periodically (cron / `brain curate`).
 */

export interface CurateOptions {
  dryRun?: boolean;
  consolidateThreshold?: number;
  promoteFrequency?: number;
  prune?: boolean;
  pruneMinImportance?: number;
  pruneMaxAgeDays?: number;
}

export interface CurateReport {
  dryRun: boolean;
  consolidation: ConsolidationReport;
  promoted: { findingId: string; standardId: string; rule: string }[];
  pruned: { label: string; id: string }[];
}

function standardIdFor(rule: string): string {
  const h = createHash("sha1").update(rule.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
  return `codingstandard:${h}`;
}

/** Recurring findings → coding standards (+ VIOLATES link). */
async function promoteFindings(
  memory: Memory,
  minFrequency: number,
  dryRun: boolean,
): Promise<CurateReport["promoted"]> {
  const promoted: CurateReport["promoted"] = [];
  const findings = await memory.repo.allNodes("ReviewFinding");
  for (const f of findings) {
    if (Number(f.frequency ?? 0) < minFrequency) continue;
    const rule = String(f.rule ?? "").trim();
    if (!rule) continue;
    const standardId = standardIdFor(rule);
    promoted.push({ findingId: String(f.id), standardId, rule });
    if (dryRun) continue;
    await memory.repo.upsertNode("CodingStandard", {
      id: standardId,
      name: `Avoid: ${rule}`.slice(0, 80),
      description: String(f.fix ?? rule),
      importance: 0.8,
    });
    await memory.repo.relate("ReviewFinding", String(f.id), "VIOLATES", "CodingStandard", standardId);
  }
  return promoted;
}

/** Drop stale, unused, low-importance knowledge (destructive; opt-in). */
async function prune(
  memory: Memory,
  minImportance: number,
  maxAgeDays: number,
  dryRun: boolean,
): Promise<CurateReport["pruned"]> {
  const pruned: CurateReport["pruned"] = [];
  const cutoffMs = maxAgeDays * 86_400_000;
  const now = Date.now();
  for (const label of ["Knowledge", "Experience", "Problem"] as const) {
    const nodes = await memory.repo.allNodes(label);
    for (const n of nodes) {
      if (Number(n.importance ?? 0.5) >= minImportance) continue;
      if (Number(n.usageCount ?? 0) > 0) continue;
      const updated = n.updatedAt instanceof Date ? n.updatedAt.getTime() : Date.parse(String(n.updatedAt ?? ""));
      if (!Number.isNaN(updated) && now - updated < cutoffMs) continue; // too recent
      pruned.push({ label, id: String(n.id) });
      if (!dryRun) await memory.db.query(`MATCH (n:${label} {id: $id}) DETACH DELETE n;`, { id: String(n.id) });
    }
  }
  return pruned;
}

export async function curate(memory: Memory, opts: CurateOptions = {}): Promise<CurateReport> {
  const dryRun = opts.dryRun ?? false;
  const consolidation = await consolidate(memory, { threshold: opts.consolidateThreshold, dryRun });
  const promoted = await promoteFindings(memory, opts.promoteFrequency ?? 3, dryRun);
  const pruned = opts.prune
    ? await prune(memory, opts.pruneMinImportance ?? 0.2, opts.pruneMaxAgeDays ?? 180, dryRun)
    : [];
  return { dryRun, consolidation, promoted, pruned };
}
