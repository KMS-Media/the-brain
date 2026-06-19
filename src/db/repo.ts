import { randomUUID } from "node:crypto";
import { GraphDB } from "./kuzu.js";
import { embed, EMBEDDING_MODEL_NAME } from "../embeddings/embedder.js";
import { KNOWLEDGE_LABELS, type NodeLabel } from "../types.js";

/**
 * Repository layer: typed create/upsert of nodes and relationships.
 *
 * Embeddings are generated on write for knowledge-bearing labels from a
 * label-specific text projection (`embedText`). Timestamps are stored via
 * Cypher `timestamp(...)`. All writes are parameterized (injection-safe).
 */

const KNOWLEDGE_SET = new Set<NodeLabel>(KNOWLEDGE_LABELS);

/** Build the text that represents a node for embedding, per label. */
function embedText(label: NodeLabel, p: Record<string, unknown>): string {
  const s = (v: unknown) => (v == null ? "" : String(v));
  switch (label) {
    case "Knowledge":
      return [s(p.title), s(p.content), (p.tags as string[] | undefined)?.join(" ")].join("\n");
    case "Decision":
      return [s(p.title), s(p.problem), s(p.decision), s(p.reasoning), s(p.alternatives)].join("\n");
    case "Experience":
      return [s(p.problem), s(p.solution), s(p.outcome)].join("\n");
    case "ReviewFinding":
      return [s(p.category), s(p.rule), s(p.example), s(p.fix)].join("\n");
    case "CodingStandard":
      return [s(p.name), s(p.description), s(p.examples)].join("\n");
    case "Problem":
      return [s(p.title), s(p.description)].join("\n");
    case "Component":
      return [s(p.name), s(p.type), s(p.description)].join("\n");
    default:
      return Object.values(p).map(s).join(" ");
  }
}

/** Columns that are scalar timestamps and must be wrapped with timestamp(). */
const TIMESTAMP_COLS = new Set(["createdAt", "updatedAt", "timestamp"]);

export interface UpsertResult {
  id: string;
}

export class Repository {
  constructor(private readonly db: GraphDB) {}

  get graph(): GraphDB {
    return this.db;
  }

  /**
   * Create or update a node. `props` may omit `id` (auto-generated) and
   * ranking fields (defaulted). Returns the id.
   */
  async upsertNode(label: NodeLabel, props: Record<string, unknown>): Promise<UpsertResult> {
    const id = (props.id as string | undefined) ?? randomUUID();
    const now = new Date().toISOString().replace("Z", "");
    const data: Record<string, unknown> = { ...props, id };

    const isKnowledge = KNOWLEDGE_SET.has(label);
    if (isKnowledge) {
      data.embedding = await embed(embedText(label, data));
      data.embeddingModel = EMBEDDING_MODEL_NAME;
      data.importance ??= 0.5;
      data.usageCount ??= 0;
    }
    if ("createdAt" in propsTablesWithTimestamps(label)) {
      data.createdAt ??= now;
      data.updatedAt = now;
    }

    // Build a parameterized MERGE on id, then SET all other props.
    const setProps = Object.keys(data).filter((k) => k !== "id");
    const setClauses = setProps
      .map((k) => (TIMESTAMP_COLS.has(k) ? `n.${k} = timestamp($${k})` : `n.${k} = $${k}`))
      .join(", ");

    const cypher =
      `MERGE (n:${label} {id: $id})` + (setClauses ? ` SET ${setClauses}` : "");
    await this.db.query(cypher, sanitize(data));
    return { id };
  }

  /** Fetch a single node's full property map by id. */
  async getNode(label: NodeLabel, id: string): Promise<Record<string, unknown> | null> {
    const rows = await this.db.query(`MATCH (n:${label} {id: $id}) RETURN n;`, { id });
    return (rows[0]?.n as Record<string, unknown> | undefined) ?? null;
  }

  /**
   * Create a relationship between two existing nodes.
   * `relType` must be one of the rel tables defined in schema.ts.
   */
  async relate(
    fromLabel: NodeLabel,
    fromId: string,
    relType: string,
    toLabel: NodeLabel,
    toId: string,
  ): Promise<void> {
    const cypher =
      `MATCH (a:${fromLabel} {id: $fromId}), (b:${toLabel} {id: $toId}) ` +
      `MERGE (a)-[:${relType}]->(b);`;
    await this.db.query(cypher, { fromId, toId });
  }

  /** Increment usageCount for a knowledge node (PRD §10 usage signal). */
  async bumpUsage(label: NodeLabel, ids: string[]): Promise<void> {
    if (!KNOWLEDGE_SET.has(label) || ids.length === 0) return;
    for (const id of ids) {
      await this.db.query(
        `MATCH (n:${label} {id: $id}) SET n.usageCount = coalesce(n.usageCount, 0) + 1;`,
        { id },
      );
    }
  }

  /** All nodes of a label with their props (used by brute-force semantic search). */
  async allNodes(label: NodeLabel): Promise<Record<string, unknown>[]> {
    const rows = await this.db.query(`MATCH (n:${label}) RETURN n;`);
    return rows.map((r) => r.n as Record<string, unknown>);
  }
}

/** Which labels store createdAt/updatedAt timestamp columns. */
function propsTablesWithTimestamps(label: NodeLabel): Record<string, true> {
  // Every label except File/Directory has createdAt/updatedAt (Project + knowledge nodes).
  if (label === "File" || label === "Directory" || label === "GitCommit") return {};
  return { createdAt: true, updatedAt: true };
}

/** Drop undefined values (Kuzu rejects undefined params). */
function sanitize(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}
