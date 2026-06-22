import { EMBEDDING_DIM } from "../config.js";

/**
 * DDL for the knowledge graph (PRD §6 node types, §7 relationships).
 *
 * Knowledge-bearing nodes carry the ranking columns used by the retrieval
 * engine (PRD §10): `embedding` (FLOAT[DIM]), `importance`, `usageCount`,
 * `createdAt`, `updatedAt`. Structural nodes (Directory/File/GitCommit) omit
 * embeddings — they are reached via graph traversal, not semantic search.
 *
 * `IF NOT EXISTS` makes schema init idempotent.
 */

const E = `FLOAT[${EMBEDDING_DIM}]`;

/** Common ranking/embedding columns appended to knowledge nodes (PRD §10, §15). */
const RANK = `embedding ${E}, embeddingModel STRING, embeddingVersion STRING, importance DOUBLE, usageCount INT64, createdAt TIMESTAMP, updatedAt TIMESTAMP`;

export const NODE_TABLES: string[] = [
  `CREATE NODE TABLE IF NOT EXISTS Project(
     id STRING PRIMARY KEY, name STRING, description STRING,
     createdAt TIMESTAMP, updatedAt TIMESTAMP)`,

  `CREATE NODE TABLE IF NOT EXISTS Component(
     id STRING PRIMARY KEY, name STRING, type STRING, description STRING, ${RANK})`,

  `CREATE NODE TABLE IF NOT EXISTS File(
     id STRING PRIMARY KEY, path STRING, language STRING, checksum STRING)`,

  `CREATE NODE TABLE IF NOT EXISTS Directory(
     id STRING PRIMARY KEY, path STRING)`,

  `CREATE NODE TABLE IF NOT EXISTS GitCommit(
     id STRING PRIMARY KEY, hash STRING, author STRING, timestamp TIMESTAMP, message STRING)`,

  `CREATE NODE TABLE IF NOT EXISTS Knowledge(
     id STRING PRIMARY KEY, title STRING, content STRING, tags STRING[], ${RANK})`,

  `CREATE NODE TABLE IF NOT EXISTS Decision(
     id STRING PRIMARY KEY, title STRING, problem STRING, decision STRING,
     reasoning STRING, alternatives STRING, date STRING, ${RANK})`,

  `CREATE NODE TABLE IF NOT EXISTS Experience(
     id STRING PRIMARY KEY, problem STRING, solution STRING, outcome STRING,
     confidence DOUBLE, ${RANK})`,

  `CREATE NODE TABLE IF NOT EXISTS ReviewFinding(
     id STRING PRIMARY KEY, severity STRING, category STRING, rule STRING,
     example STRING, fix STRING, frequency INT64, ${RANK})`,

  `CREATE NODE TABLE IF NOT EXISTS CodingStandard(
     id STRING PRIMARY KEY, name STRING, description STRING, examples STRING, ${RANK})`,

  `CREATE NODE TABLE IF NOT EXISTS Problem(
     id STRING PRIMARY KEY, title STRING, description STRING, ${RANK})`,
];

/**
 * Relationship tables (PRD §7). Multi-pair FROM/TO is verified to work in
 * Kuzu 0.11. Each relationship may carry no properties (MVP) — they are
 * pure structural/semantic edges.
 */
export interface RelDef {
  type: string;
  /** Allowed [FROM, TO] label pairs for this relationship. */
  pairs: [string, string][];
}

/**
 * Single source of truth for the relationship model. The DDL below and the
 * edge-rewiring logic in consolidation both derive from this, so they can
 * never drift apart.
 */
export const REL_DEFS: RelDef[] = [
  // Projektstruktur
  { type: "CONTAINS", pairs: [["Project", "Component"], ["Project", "Directory"], ["Directory", "File"]] },
  // Architektur
  { type: "USES", pairs: [["Component", "Component"]] },
  { type: "CALLS", pairs: [["Component", "Component"]] },
  { type: "DEPENDS_ON", pairs: [["Component", "Component"]] },
  // Entscheidungen
  { type: "AFFECTS", pairs: [["Decision", "Component"], ["ReviewFinding", "Component"], ["ReviewFinding", "File"]] },
  { type: "REPLACES", pairs: [["Decision", "Decision"]] },
  { type: "IMPLEMENTS", pairs: [["Decision", "Knowledge"], ["GitCommit", "Decision"]] },
  // Review findings
  { type: "VIOLATES", pairs: [["ReviewFinding", "CodingStandard"]] },
  // Erfahrungen
  { type: "SOLVES", pairs: [["Experience", "Problem"]] },
  { type: "RELATES_TO", pairs: [["Experience", "Component"]] },
  // Git
  { type: "MODIFIES", pairs: [["GitCommit", "File"]] },
  { type: "FIXES", pairs: [["GitCommit", "ReviewFinding"]] },
];

export const REL_TABLES: string[] = REL_DEFS.map(
  (d) => `CREATE REL TABLE IF NOT EXISTS ${d.type}(${d.pairs.map(([f, t]) => `FROM ${f} TO ${t}`).join(", ")})`,
);

export const ALL_DDL: string[] = [...NODE_TABLES, ...REL_TABLES];

/** Knowledge-bearing labels that carry the embedding/ranking columns. */
const KNOWLEDGE_TABLES = [
  "Component",
  "Knowledge",
  "Decision",
  "Experience",
  "ReviewFinding",
  "CodingStandard",
  "Problem",
];

/**
 * Idempotent column migrations for databases created by an earlier schema.
 * `ADD IF NOT EXISTS` is a no-op when the column already exists, so this is
 * safe to run on every open.
 */
export const MIGRATIONS: string[] = KNOWLEDGE_TABLES.map(
  (t) => `ALTER TABLE ${t} ADD IF NOT EXISTS embeddingVersion STRING`,
);
