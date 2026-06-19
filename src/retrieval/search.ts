import { GraphDB } from "../db/kuzu.js";
import { embed } from "../embeddings/embedder.js";
import { KNOWLEDGE_LABELS, type NodeLabel, type ScoredNode } from "../types.js";
import { combine, type Signals } from "./ranking.js";

/**
 * Retrieval pipeline (PRD §9):
 *   query → embedding → semantic search → graph traversal →
 *   relationship expansion → ranking
 *
 * Semantic search runs inside Kuzu via the native `array_cosine_similarity`
 * function (verified available), so no vectors leave the DB process and we
 * meet the latency targets (PRD §16) without a brute-force JS scan.
 */

export interface SearchOptions {
  limit?: number;
  /** How many semantic seeds per label feed graph expansion. */
  seedPerLabel?: number;
}

interface Candidate {
  label: NodeLabel;
  id: string;
  props: Record<string, unknown>;
  semantic: number;
  graphConnections: number;
}

export class SearchEngine {
  constructor(private readonly db: GraphDB) {}

  /** Full pipeline: returns ranked, scored nodes for a free-text query. */
  async search(query: string, opts: SearchOptions = {}): Promise<ScoredNode[]> {
    const limit = opts.limit ?? 20;
    const seedPerLabel = opts.seedPerLabel ?? 8;
    const qvec = await embed(query);

    // 1. Semantic search per knowledge label (in-DB cosine).
    const byId = new Map<string, Candidate>();
    for (const label of KNOWLEDGE_LABELS) {
      const rows = await this.semanticByLabel(label, qvec, seedPerLabel);
      for (const row of rows) {
        const node = row.n as Record<string, unknown>;
        const sim = Number(row.sim ?? 0);
        const key = `${label}:${node.id}`;
        byId.set(key, {
          label,
          id: String(node.id),
          props: node,
          semantic: sim,
          graphConnections: 0,
        });
      }
    }

    // 2. Relationship expansion: pull 1-hop neighbors of the seeds.
    await this.expand(byId, qvec);

    // 3. Graph relevance: count edges between candidates.
    await this.scoreGraphConnections(byId);

    // 4. Rank.
    const now = Date.now();
    const candidates = [...byId.values()];
    const maxConnections = Math.max(1, ...candidates.map((c) => c.graphConnections));
    const maxUsage = Math.max(1, ...candidates.map((c) => Number(c.props.usageCount ?? 0)));

    const scored: ScoredNode[] = candidates.map((c) => {
      const signals: Signals = {
        semantic: c.semantic,
        graphConnections: c.graphConnections,
        importance: Number(c.props.importance ?? 0.5),
        usageCount: Number(c.props.usageCount ?? 0),
        updatedAt: (c.props.updatedAt as string | Date | undefined) ?? (c.props.createdAt as string | Date | undefined),
      };
      const b = combine(signals, { now, maxConnections, maxUsage });
      return {
        label: c.label,
        id: c.id,
        props: c.props,
        score: b.score,
        breakdown: { semantic: b.semantic, graph: b.graph, importance: b.importance, usage: b.usage, recency: b.recency },
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** In-DB cosine similarity search for one label. */
  private async semanticByLabel(label: NodeLabel, qvec: number[], k: number): Promise<Record<string, unknown>[]> {
    const cypher =
      `MATCH (n:${label}) WHERE n.embedding IS NOT NULL ` +
      `RETURN n, array_cosine_similarity(n.embedding, $q) AS sim ` +
      `ORDER BY sim DESC LIMIT ${Math.max(1, Math.floor(k))};`;
    try {
      return await this.db.query(cypher, { q: qvec });
    } catch {
      return [];
    }
  }

  /** Add 1-hop neighbors (any relationship, any direction) of current candidates. */
  private async expand(byId: Map<string, Candidate>, qvec: number[]): Promise<void> {
    const seeds = [...byId.values()];
    for (const seed of seeds) {
      const rows = await this.db.query(
        `MATCH (a:${seed.label} {id: $id})-[]-(b) RETURN b;`,
        { id: seed.id },
      );
      for (const row of rows) {
        const node = row.b as Record<string, unknown>;
        const label = String(node._label) as NodeLabel;
        if (!node.id) continue;
        const key = `${label}:${node.id}`;
        if (byId.has(key)) continue;
        // Neighbor brought in by graph: give it a semantic score if it has an embedding.
        let semantic = 0;
        const emb = node.embedding as number[] | undefined;
        if (Array.isArray(emb) && emb.length === qvec.length) {
          semantic = cosineLocal(emb, qvec);
        }
        byId.set(key, { label, id: String(node.id), props: node, semantic, graphConnections: 0 });
      }
    }
  }

  /** For each candidate, count edges to other candidates (co-relevance signal). */
  private async scoreGraphConnections(byId: Map<string, Candidate>): Promise<void> {
    const idSet = new Set([...byId.values()].map((c) => c.id));
    for (const cand of byId.values()) {
      const rows = await this.db.query(
        `MATCH (a:${cand.label} {id: $id})-[]-(b) RETURN b.id AS bid;`,
        { id: cand.id },
      );
      let connections = 0;
      for (const row of rows) {
        if (idSet.has(String(row.bid))) connections++;
      }
      cand.graphConnections = connections;
    }
  }
}

/** Local cosine for neighbors already loaded into memory (avoids a DB round-trip). */
function cosineLocal(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are L2-normalized at write time
}
