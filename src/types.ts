/**
 * Domain types mirroring the PRD data model (§6) and relationship model (§7).
 */

export type NodeLabel =
  | "Project"
  | "Component"
  | "File"
  | "Directory"
  | "GitCommit"
  | "Knowledge"
  | "Decision"
  | "Experience"
  | "ReviewFinding"
  | "CodingStandard"
  | "Problem";

/** Labels that carry an embedding and participate in semantic search / ranking. */
export const KNOWLEDGE_LABELS: NodeLabel[] = [
  "Knowledge",
  "Decision",
  "Experience",
  "ReviewFinding",
  "CodingStandard",
  "Problem",
  "Component",
];

export interface BaseNode {
  id: string;
  /** 0..1 manual importance weight (PRD §10). */
  importance?: number;
  /** Times this node has been surfaced in a context (PRD §10 usage_count). */
  usageCount?: number;
  createdAt?: string; // ISO 8601
  updatedAt?: string; // ISO 8601
}

export interface Project extends BaseNode {
  name: string;
  description?: string;
}

export interface Component extends BaseNode {
  name: string;
  /** Service | API | Frontend | Worker | Library | ... */
  type?: string;
  description?: string;
}

export interface FileNode extends BaseNode {
  path: string;
  language?: string;
  checksum?: string;
}

export interface DirectoryNode extends BaseNode {
  path: string;
}

export interface GitCommit extends BaseNode {
  hash: string;
  author?: string;
  timestamp?: string;
  message?: string;
}

export interface Knowledge extends BaseNode {
  title: string;
  content: string;
  tags?: string[];
}

export interface Decision extends BaseNode {
  title: string;
  problem?: string;
  decision: string;
  reasoning?: string;
  alternatives?: string;
  date?: string;
}

export interface Experience extends BaseNode {
  problem: string;
  solution: string;
  outcome?: string;
  /** 0..1 confidence in this learned experience. */
  confidence?: number;
}

export interface ReviewFinding extends BaseNode {
  severity?: string; // info | low | medium | high | critical
  category?: string;
  rule: string;
  example?: string;
  fix?: string;
  frequency?: number;
}

export interface CodingStandard extends BaseNode {
  name: string;
  description: string;
  examples?: string;
}

export interface ProblemNode extends BaseNode {
  title: string;
  description?: string;
}

/** A scored search hit returned by the retrieval engine. */
export interface ScoredNode {
  label: NodeLabel;
  id: string;
  /** All stored properties of the node. */
  props: Record<string, unknown>;
  /** Final combined ranking score. */
  score: number;
  /** Component scores (for debugging / transparency). */
  breakdown: {
    semantic: number;
    graph: number;
    importance: number;
    usage: number;
    recency: number;
  };
}

/** The assembled context returned to Claude (PRD §8 context query). */
export interface MemoryContext {
  summary: string;
  findings: string[];
  standards: string[];
  decisions: string[];
  architecture: string[];
  experiences: string[];
  knowledge: string[];
  /** Ready-to-inject Markdown block. */
  markdown: string;
}
