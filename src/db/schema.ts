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
export const REL_TABLES: string[] = [
  // Projektstruktur
  `CREATE REL TABLE IF NOT EXISTS CONTAINS(
     FROM Project TO Component, FROM Project TO Directory, FROM Directory TO File)`,

  // Architektur
  `CREATE REL TABLE IF NOT EXISTS USES(FROM Component TO Component)`,
  `CREATE REL TABLE IF NOT EXISTS CALLS(FROM Component TO Component)`,
  `CREATE REL TABLE IF NOT EXISTS DEPENDS_ON(FROM Component TO Component)`,

  // Entscheidungen
  `CREATE REL TABLE IF NOT EXISTS AFFECTS(
     FROM Decision TO Component, FROM ReviewFinding TO Component, FROM ReviewFinding TO File)`,
  `CREATE REL TABLE IF NOT EXISTS REPLACES(FROM Decision TO Decision)`,
  `CREATE REL TABLE IF NOT EXISTS IMPLEMENTS(
     FROM Decision TO Knowledge, FROM GitCommit TO Decision)`,

  // Review findings
  `CREATE REL TABLE IF NOT EXISTS VIOLATES(FROM ReviewFinding TO CodingStandard)`,

  // Erfahrungen
  `CREATE REL TABLE IF NOT EXISTS SOLVES(FROM Experience TO Problem)`,
  `CREATE REL TABLE IF NOT EXISTS RELATES_TO(FROM Experience TO Component)`,

  // Git
  `CREATE REL TABLE IF NOT EXISTS MODIFIES(FROM GitCommit TO File)`,
  `CREATE REL TABLE IF NOT EXISTS FIXES(FROM GitCommit TO ReviewFinding)`,
];

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
