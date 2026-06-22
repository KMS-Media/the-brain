import { readFileSync, writeFileSync } from "node:fs";
import type { Memory } from "./core.js";
import { KNOWLEDGE_LABELS, type NodeLabel } from "./types.js";
import { REL_DEFS } from "./db/schema.js";
import { encrypt, decrypt } from "./backup.js";

/**
 * Team sharing (PRD §21 V2).
 *
 * Exports a project's knowledge into a portable, mergeable bundle (JSON, with
 * optional AES-256-GCM encryption via BRAIN_BACKUP_KEY) that a teammate can
 * import and MERGE into their own local store — no server, no cloud. Imported
 * nodes are re-embedded locally; running consolidation afterwards collapses
 * near-duplicates that two people captured independently.
 */

const BUNDLE_MAGIC = "BRAINSHARE1";
/**
 * Local-only/derived fields dropped on export. Everything else (content,
 * importance, frequency, confidence, tags, …) travels with the shared node;
 * the embedding is regenerated locally on import.
 */
const DROP = new Set(["_label", "_id", "embedding", "embeddingModel", "embeddingVersion", "usageCount", "createdAt", "updatedAt"]);

export interface BundleNode {
  label: NodeLabel;
  props: Record<string, unknown>;
}
export interface BundleEdge {
  type: string;
  fromLabel: string;
  from: string;
  toLabel: string;
  to: string;
}
export interface ShareBundle {
  magic: string;
  version: 1;
  nodes: BundleNode[];
  edges: BundleEdge[];
}

/** Collect knowledge nodes + the edges among them into a portable bundle. */
export async function exportBundle(memory: Memory): Promise<ShareBundle> {
  const nodes: BundleNode[] = [];
  const ids = new Set<string>();
  for (const label of KNOWLEDGE_LABELS) {
    for (const n of await memory.repo.allNodes(label)) {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(n)) {
        if (DROP.has(k)) continue;
        if (v == null) continue;
        props[k] = v; // keep id, content fields, and shared signals
      }
      nodes.push({ label, props });
      ids.add(String(n.id));
    }
  }

  const edges: BundleEdge[] = [];
  for (const def of REL_DEFS) {
    for (const [fromLabel, toLabel] of def.pairs) {
      if (!KNOWLEDGE_LABELS.includes(fromLabel as NodeLabel) || !KNOWLEDGE_LABELS.includes(toLabel as NodeLabel)) continue;
      const rows = await memory.db.query(
        `MATCH (a:${fromLabel})-[:${def.type}]->(b:${toLabel}) RETURN a.id AS f, b.id AS t;`,
      );
      for (const r of rows) {
        const from = String(r.f);
        const to = String(r.t);
        if (ids.has(from) && ids.has(to)) edges.push({ type: def.type, fromLabel, from, toLabel, to });
      }
    }
  }

  return { magic: BUNDLE_MAGIC, version: 1, nodes, edges };
}

/** Write a bundle to disk, encrypted if a passphrase is given. */
export async function writeBundle(memory: Memory, path: string, passphrase?: string): Promise<{ nodes: number; edges: number; encrypted: boolean }> {
  const bundle = await exportBundle(memory);
  let buf: Buffer = Buffer.from(JSON.stringify(bundle), "utf8");
  const encrypted = Boolean(passphrase);
  if (passphrase) buf = encrypt(buf, passphrase);
  writeFileSync(path, buf);
  return { nodes: bundle.nodes.length, edges: bundle.edges.length, encrypted };
}

export interface ImportResult {
  nodes: number;
  edges: number;
}

/** Merge a bundle's nodes + edges into the target memory (re-embedding nodes). */
export async function importBundle(memory: Memory, bundle: ShareBundle): Promise<ImportResult> {
  if (bundle.magic !== BUNDLE_MAGIC) throw new Error("Not a the_brain share bundle.");
  for (const node of bundle.nodes) {
    await memory.repo.upsertNode(node.label, node.props); // keeps id, re-embeds locally
  }
  let edges = 0;
  for (const e of bundle.edges) {
    await memory.repo.relate(e.fromLabel as NodeLabel, e.from, e.type, e.toLabel as NodeLabel, e.to);
    edges++;
  }
  return { nodes: bundle.nodes.length, edges };
}

/** Read + (decrypt) + import a bundle file. */
export async function readAndImport(memory: Memory, path: string, passphrase?: string): Promise<ImportResult> {
  let buf: Buffer = readFileSync(path);
  // Detect encryption by trying JSON first; fall back to decrypt.
  let text: string;
  if (buf.subarray(0, 1).toString() === "{") {
    text = buf.toString("utf8");
  } else {
    if (!passphrase) throw new Error("Bundle appears encrypted — set BRAIN_BACKUP_KEY to import.");
    text = decrypt(buf, passphrase).toString("utf8");
  }
  return importBundle(memory, JSON.parse(text) as ShareBundle);
}
