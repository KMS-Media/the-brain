import { GraphDB } from "../db/kuzu.js";
import { embed } from "../embeddings/embedder.js";
import { KNOWLEDGE_LABELS, type NodeLabel, type ScoredNode } from "../types.js";
import { combine, type Signals } from "./ranking.js";
import { analyzeIntent } from "./intent.js";

/**
 * Retrieval pipeline (PRD §9):
 *   query → embedding → semantic search → graph traversal →
 *   relationship expansion → ranking
 *
 * Semantic search runs inside Kuzu via the native `array_cosine_similarity`
 * function. A benchmark showed this SIMD scan stays well under the §16 latency
 * budget at the target size (~9 ms @ 20k, ~45 ms @ 100k) — and the native HNSW
 * vector index gives no read speedup at that scale while making writes ~10×
 * slower, so it is deliberately not used.
 *
 * The graph steps (expansion + connection counting) are BATCHED: each is a
 * single label-less `MATCH (a)-[]-(b) WHERE a.id IN $ids` query instead of one
 * query per candidate, removing the previous N+1 pattern (the real bottleneck).
 */

const KNOWLEDGE_SET = new Set<NodeLabel>(KNOWLEDGE_LABELS);

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

    // 0. Intent analysis (PRD §9): classify the prompt before embedding so we
    //    can widen retrieval for the relevant kinds of memory and nudge ranking.
    const intent = analyzeIntent(query);
    const focused = new Set(intent.focus);

    const qvec = await embed(query);

    // 1. Semantic search per knowledge label (in-DB cosine). Only the id +
    //    ranking columns are returned here — fetching the full node (incl. the
    //    384-float embedding) for every scan hit is ~2.5× slower, and the
    //    render fields are needed only for the final slice (hydrated in step 5).
    const byId = new Map<string, Candidate>();
    for (const label of KNOWLEDGE_LABELS) {
      // Focused labels get more retrieval breadth.
      const k = focused.has(label) ? seedPerLabel * 2 : seedPerLabel;
      const rows = await this.semanticByLabel(label, qvec, k);
      for (const row of rows) {
        const id = String(row.id);
        byId.set(`${label}:${id}`, {
          label,
          id,
          props: { id, importance: row.importance, usageCount: row.usageCount, updatedAt: row.updatedAt },
          semantic: Number(row.sim ?? 0),
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
      // Intent nudge (PRD §9): small additive boost for the prompt's focus labels.
      const score = b.score + (intent.boost[c.label] ?? 0);
      // Drop the embedding from the surfaced props — large and never needed downstream.
      const { embedding: _omit, ...props } = c.props;
      return {
        label: c.label,
        id: c.id,
        props,
        score,
        breakdown: { semantic: b.semantic, graph: b.graph, importance: b.importance, usage: b.usage, recency: b.recency },
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    // 5. Hydrate the full render properties for the final slice only.
    await this.hydrate(top);
    return top;
  }

  /** In-DB cosine similarity search for one label (id + ranking columns only). */
  private async semanticByLabel(label: NodeLabel, qvec: number[], k: number): Promise<Record<string, unknown>[]> {
    const cypher =
      `MATCH (n:${label}) WHERE n.embedding IS NOT NULL ` +
      `RETURN n.id AS id, n.importance AS importance, n.usageCount AS usageCount, ` +
      `n.updatedAt AS updatedAt, array_cosine_similarity(n.embedding, $q) AS sim ` +
      `ORDER BY sim DESC LIMIT ${Math.max(1, Math.floor(k))};`;
    try {
      return await this.db.query(cypher, { q: qvec });
    } catch {
      return [];
    }
  }

  /** Fetch full node properties (minus embedding) for the final ranked slice. */
  private async hydrate(nodes: ScoredNode[]): Promise<void> {
    const ids = [...new Set(nodes.map((n) => n.id))];
    if (ids.length === 0) return;
    const rows = await this.db.query(`MATCH (n) WHERE n.id IN $ids RETURN n;`, { ids });
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const n = row.n as Record<string, unknown>;
      const { embedding: _omit, ...props } = n;
      byId.set(`${String(n._label)}:${String(n.id)}`, props);
    }
    for (const node of nodes) {
      const full = byId.get(`${node.label}:${node.id}`);
      if (full) node.props = full;
    }
  }

  /**
   * Add 1-hop neighbors of the current seeds in ONE batched query. Only
   * knowledge-bearing neighbors are kept — structural nodes (File/Directory/
   * GitCommit) are never rendered and would only add noise to ranking.
   */
  private async expand(byId: Map<string, Candidate>, qvec: number[]): Promise<void> {
    const seedIds = [...byId.values()].map((c) => c.id);
    if (seedIds.length === 0) return;
    const rows = await this.db.query(
      `MATCH (a)-[]-(b) WHERE a.id IN $ids RETURN DISTINCT b;`,
      { ids: seedIds },
    );
    for (const row of rows) {
      const node = row.b as Record<string, unknown>;
      const label = String(node._label) as NodeLabel;
      if (!node.id || !KNOWLEDGE_SET.has(label)) continue;
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

  /**
   * Count, for every candidate, how many of its edges land on another
   * candidate (co-relevance signal) — in ONE batched query. The undirected
   * `-[]-` match yields each intra-set edge from both endpoints, so tallying by
   * `aid` gives each node its degree within the candidate set.
   */
  private async scoreGraphConnections(byId: Map<string, Candidate>): Promise<void> {
    const ids = [...new Set([...byId.values()].map((c) => c.id))];
    if (ids.length === 0) return;
    const rows = await this.db.query(
      `MATCH (a)-[]-(b) WHERE a.id IN $ids AND b.id IN $ids RETURN a.id AS aid, b.id AS bid;`,
      { ids },
    );
    const counts = new Map<string, number>();
    for (const row of rows) {
      const aid = String(row.aid);
      if (aid === String(row.bid)) continue; // ignore self-loops
      counts.set(aid, (counts.get(aid) ?? 0) + 1);
    }
    for (const cand of byId.values()) cand.graphConnections = counts.get(cand.id) ?? 0;
  }
}

/** Local cosine for neighbors already loaded into memory (avoids a DB round-trip). */
function cosineLocal(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are L2-normalized at write time
}
