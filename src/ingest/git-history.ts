import { resolve } from "node:path";
import type { Memory } from "../core.js";
import { git, isGitRepo } from "./git-utils.js";

/**
 * Git history ingestion (PRD §6 GitCommit, §7 (GitCommit)-[:MODIFIES]->(File)).
 *
 * Reads the most recent commits and materializes GitCommit nodes plus MODIFIES
 * edges to the File nodes created by scanStructure. Files touched by a commit
 * but no longer tracked simply produce no edge (relate() MATCHes both ends).
 */

export interface GitIngestResult {
  commits: number;
  edges: number;
}

const US = ""; // unit separator between header fields

/** Normalize a strict-ISO git timestamp (with offset) to naive UTC for Kuzu. */
function toKuzuTimestamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return new Date(0).toISOString().replace("Z", "");
  return new Date(t).toISOString().replace("Z", "");
}

export async function ingestGitHistory(
  memory: Memory,
  projectPath: string = process.cwd(),
  limit = 100,
): Promise<GitIngestResult> {
  const root = resolve(projectPath);
  if (!(await isGitRepo(root))) {
    throw new Error(`Not a git repository: ${root}.`);
  }

  const stdout = await git(root, [
    "log",
    `-n${Math.max(1, Math.floor(limit))}`,
    `--pretty=format:%H${US}%an${US}%aI${US}%s`,
    "--name-only",
  ]);

  let commits = 0;
  let edges = 0;
  let currentHash: string | null = null;

  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.includes(US)) {
      // Commit header: create the GitCommit node immediately so its MODIFIES
      // edges (parsed from the following lines) can MATCH it.
      const [hash, author, ts, ...msg] = line.split(US);
      await memory.repo.upsertNode("GitCommit", {
        id: hash,
        hash,
        author,
        timestamp: toKuzuTimestamp(ts),
        message: msg.join(US),
      });
      currentHash = hash;
      commits++;
    } else if (line.trim() && currentHash) {
      // A changed file path belonging to the current commit.
      const path = line.trim().split("\\").join("/");
      await memory.repo.relate("GitCommit", currentHash, "MODIFIES", "File", path);
      edges++;
    }
  }

  return { commits, edges };
}
