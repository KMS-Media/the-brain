import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Memory } from "./core.js";
import { dbPath } from "./config.js";
import type { NodeLabel, ScoredNode } from "./types.js";

/**
 * Multi-project graph & cross-project knowledge transfer (PRD §21 V2).
 *
 * Each project keeps its own Kuzu store under BRAIN_HOME/<project-slug>/. These
 * helpers federate over those stores: discover them, search across all of them
 * at once, and copy a knowledge node from one project into another.
 *
 * All operations are additive — federated search is read-only per store, and
 * transfer only writes (a fresh embedding) into the target store.
 */

export interface ProjectRef {
  name: string;
  storageDir: string;
}

/** Root directory that holds all per-project stores. */
export function memoryHome(home?: string): string {
  return home ?? process.env.BRAIN_HOME ?? join(homedir(), ".claude-memory");
}

/** Discover every project store under the memory home (those with a graph DB). */
export function listProjects(home?: string): ProjectRef[] {
  const base = memoryHome(home);
  if (!existsSync(base)) return [];
  const out: ProjectRef[] = [];
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === "models") continue;
    const storageDir = join(base, e.name);
    if (existsSync(dbPath(storageDir))) out.push({ name: e.name, storageDir });
  }
  return out;
}

export interface CrossProjectHit extends ScoredNode {
  project: string;
}

/**
 * Search every project store and return the globally top-ranked hits, each
 * tagged with its source project. The query is embedded once per store (cheap;
 * the model is loaded once for the process).
 */
export async function searchAcrossProjects(query: string, limit = 20, home?: string): Promise<CrossProjectHit[]> {
  const projects = listProjects(home);
  const all: CrossProjectHit[] = [];
  for (const p of projects) {
    const mem = await Memory.openAt(p.storageDir);
    try {
      const hits = await mem.search(query, limit);
      for (const h of hits) all.push({ ...h, project: p.name });
    } finally {
      mem.close();
    }
  }
  all.sort((a, b) => b.score - a.score);
  return all.slice(0, limit);
}

/** Fields that are storage-internal and must not be copied verbatim on transfer. */
const INTERNAL = new Set([
  "_label",
  "_id",
  "embedding",
  "embeddingModel",
  "embeddingVersion",
  "usageCount",
  "createdAt",
  "updatedAt",
]);

export interface TransferResult {
  from: string;
  to: string;
  label: NodeLabel;
  sourceId: string;
  newId: string;
}

/**
 * Copy a knowledge node from one project into another (Cross-Project Knowledge
 * Transfer). The target re-embeds the content itself, so the copy is a
 * first-class node in the destination graph (fresh embedding, reset usage).
 */
export async function transferNode(
  from: ProjectRef,
  to: ProjectRef,
  label: NodeLabel,
  id: string,
): Promise<TransferResult> {
  const src = await Memory.openAt(from.storageDir);
  let node: Record<string, unknown> | null;
  try {
    node = await src.repo.getNode(label, id);
  } finally {
    src.close();
  }
  if (!node) throw new Error(`Node ${label}:${id} not found in project "${from.name}".`);

  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (!INTERNAL.has(k)) props[k] = v;
  }

  const dst = await Memory.openAt(to.storageDir);
  try {
    const { id: newId } = await dst.repo.upsertNode(label, props);
    return { from: from.name, to: to.name, label, sourceId: id, newId };
  } finally {
    dst.close();
  }
}

/** Resolve a project by name (exact, else case-insensitive). */
export function findProject(name: string, home?: string): ProjectRef | undefined {
  const projects = listProjects(home);
  return projects.find((p) => p.name === name) ?? projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
}
