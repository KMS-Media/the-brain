import type { Memory } from "../core.js";
import { scanStructure, type ScanResult } from "./scanner.js";
import { ingestGitHistory, type GitIngestResult } from "./git-history.js";

export { scanStructure } from "./scanner.js";
export { ingestGitHistory } from "./git-history.js";
export { detectLanguage } from "./language.js";

export interface IngestResult {
  structure: ScanResult;
  git: GitIngestResult;
}

/**
 * Full structural auto-ingestion: project/directory/file structure first
 * (so File nodes exist), then git history with MODIFIES edges.
 */
export async function ingest(memory: Memory, projectPath?: string, gitLimit = 100): Promise<IngestResult> {
  const structure = await scanStructure(memory, projectPath);
  const git = await ingestGitHistory(memory, projectPath, gitLimit);
  return { structure, git };
}
