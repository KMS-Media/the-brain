import type { Memory } from "./core.js";
import { KNOWLEDGE_LABELS, type NodeLabel } from "./types.js";
import { REL_DEFS } from "./db/schema.js";

/**
 * Knowledge consolidation (PRD §21 V2; supports §20.6/§20.7 "quality rises over
 * time, repeated mistakes shrink").
 *
 * Graph-wide maintenance that finds semantically duplicate knowledge nodes of
 * the same label (cosine ≥ threshold), keeps one canonical survivor, rewires
 * ALL relationships from the duplicates onto the survivor, accumulates the
 * usage/frequency signals, and deletes the duplicates. `dryRun` reports what
 * would happen without changing anything.
 */

export interface ConsolidationOptions {
  threshold?: number;
  labels?: NodeLabel[];
  dryRun?: boolean;
  /** Skip labels with more nodes than this (pairwise clustering is O(n²)). */
  maxNodesPerLabel?: number;
}

export interface MergeRecord {
  label: NodeLabel;
  survivor: string;
  merged: string[];
}

export interface ConsolidationReport {
  threshold: number;
  dryRun: boolean;
  merges: MergeRecord[];
  clustersMerged: number;
  nodesRemoved: number;
  skipped: { label: NodeLabel; nodes: number }[];
}

/** Build clusters of node indices whose embeddings are ≥ threshold similar. */
function clusterByCosine(embeddings: number[][], threshold: number): number[][] {
  const n = embeddings.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < n; i++) {
    const a = embeddings[i];
    if (!a || a.length === 0) continue;
    for (let j = i + 1; j < n; j++) {
      const b = embeddings[j];
      if (!b || b.length !== a.length) continue;
      let dot = 0;
      for (let k = 0; k < a.length; k++) dot += a[k] * b[k]; // normalized → cosine
      if (dot >= threshold) union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r) ?? [];
    g.push(i);
    groups.set(r, g);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Choose the canonical survivor: highest importance, then usage, then frequency. */
function pickSurvivor(nodes: Record<string, unknown>[]): Record<string, unknown> {
  return [...nodes].sort((a, b) => {
    const imp = Number(b.importance ?? 0) - Number(a.importance ?? 0);
    if (imp) return imp;
    const usage = Number(b.usageCount ?? 0) - Number(a.usageCount ?? 0);
    if (usage) return usage;
    const freq = Number(b.frequency ?? 0) - Number(a.frequency ?? 0);
    if (freq) return freq;
    return String(a.id).localeCompare(String(b.id)); // stable
  })[0];
}

/** Move every edge of `dupId` onto `survivorId`, skipping endpoints in the cluster. */
async function rewireEdges(
  memory: Memory,
  label: NodeLabel,
  dupId: string,
  survivorId: string,
  clusterIds: Set<string>,
): Promise<void> {
  for (const def of REL_DEFS) {
    for (const [from, to] of def.pairs) {
      if (from === label) {
        // outgoing: (dup)-[type]->(x:to)
        const rows = await memory.db.query(
          `MATCH (d:${label} {id: $id})-[:${def.type}]->(x:${to}) RETURN x.id AS xid;`,
          { id: dupId },
        );
        for (const r of rows) {
          const xid = String(r.xid);
          if (clusterIds.has(xid)) continue; // avoid self-loops / edges to deleted dups
          await memory.db.query(
            `MATCH (s:${label} {id: $s}), (x:${to} {id: $x}) MERGE (s)-[:${def.type}]->(x);`,
            { s: survivorId, x: xid },
          );
        }
      }
      if (to === label) {
        // incoming: (y:from)-[type]->(dup)
        const rows = await memory.db.query(
          `MATCH (y:${from})-[:${def.type}]->(d:${label} {id: $id}) RETURN y.id AS yid;`,
          { id: dupId },
        );
        for (const r of rows) {
          const yid = String(r.yid);
          if (clusterIds.has(yid)) continue;
          await memory.db.query(
            `MATCH (y:${from} {id: $y}), (s:${label} {id: $s}) MERGE (y)-[:${def.type}]->(s);`,
            { y: yid, s: survivorId },
          );
        }
      }
    }
  }
}

/** Roll the duplicates' usage/frequency/importance into the survivor. */
async function mergeScalars(
  memory: Memory,
  label: NodeLabel,
  cluster: Record<string, unknown>[],
  survivorId: string,
): Promise<void> {
  const importance = Math.max(...cluster.map((n) => Number(n.importance ?? 0)));
  const usageCount = cluster.reduce((s, n) => s + Number(n.usageCount ?? 0), 0);
  if (label === "ReviewFinding") {
    const frequency = cluster.reduce((s, n) => s + Number(n.frequency ?? 0), 0);
    await memory.db.query(
      `MATCH (s:${label} {id: $id}) SET s.importance = $imp, s.usageCount = $uc, s.frequency = $fr;`,
      { id: survivorId, imp: importance, uc: usageCount, fr: frequency },
    );
  } else {
    await memory.db.query(
      `MATCH (s:${label} {id: $id}) SET s.importance = $imp, s.usageCount = $uc;`,
      { id: survivorId, imp: importance, uc: usageCount },
    );
  }
}

export async function consolidate(memory: Memory, opts: ConsolidationOptions = {}): Promise<ConsolidationReport> {
  const threshold = opts.threshold ?? 0.95;
  const labels = opts.labels ?? KNOWLEDGE_LABELS;
  const dryRun = opts.dryRun ?? false;
  const maxNodesPerLabel = opts.maxNodesPerLabel ?? 5000;

  const merges: MergeRecord[] = [];
  const skipped: { label: NodeLabel; nodes: number }[] = [];
  let nodesRemoved = 0;

  for (const label of labels) {
    const nodes = await memory.repo.allNodes(label);
    if (nodes.length < 2) continue;
    if (nodes.length > maxNodesPerLabel) {
      skipped.push({ label, nodes: nodes.length });
      continue;
    }
    const embeddings = nodes.map((n) => (Array.isArray(n.embedding) ? (n.embedding as number[]) : []));
    const clusters = clusterByCosine(embeddings, threshold);

    for (const idxs of clusters) {
      const group = idxs.map((i) => nodes[i]);
      const survivor = pickSurvivor(group);
      const survivorId = String(survivor.id);
      const dups = group.filter((n) => String(n.id) !== survivorId);
      const clusterIds = new Set(group.map((n) => String(n.id)));

      merges.push({ label, survivor: survivorId, merged: dups.map((d) => String(d.id)) });

      if (!dryRun) {
        for (const dup of dups) await rewireEdges(memory, label, String(dup.id), survivorId, clusterIds);
        await mergeScalars(memory, label, group, survivorId);
        for (const dup of dups) {
          await memory.db.query(`MATCH (d:${label} {id: $id}) DETACH DELETE d;`, { id: String(dup.id) });
        }
      }
      nodesRemoved += dups.length;
    }
  }

  return { threshold, dryRun, merges, clustersMerged: merges.length, nodesRemoved, skipped };
}
