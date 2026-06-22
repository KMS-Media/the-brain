import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Memory } from "./core.js";

const pexec = promisify(execFile);

/**
 * GitHub integration (PRD §21 V2).
 *
 * Pulls issues and pull requests via the `gh` CLI and materializes them as
 * graph knowledge: issues → Problem nodes, PRs → Decision nodes. Commits whose
 * message references a PR (#N) are linked GitCommit-[:IMPLEMENTS]->Decision, so
 * the git history (from `brain ingest`) ties into the project's intent.
 *
 * Degrades gracefully: if `gh` is missing or unauthenticated, ingestion throws
 * a clear error rather than crashing.
 */

export async function gh(args: string[], cwd = process.cwd()): Promise<string> {
  const { stdout } = await pexec("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

export async function isGhAvailable(cwd = process.cwd()): Promise<boolean> {
  try {
    await pexec("gh", ["auth", "status"], { cwd });
    return true;
  } catch {
    return false;
  }
}

export interface GhIssue {
  number: number;
  title: string;
  body?: string;
  state?: string;
}
export interface GhPull {
  number: number;
  title: string;
  body?: string;
  state?: string;
}

export interface BuiltNode {
  label: "Problem" | "Decision";
  props: Record<string, unknown>;
}

/** Pure: GitHub issues → Problem nodes. */
export function issuesToNodes(issues: GhIssue[]): BuiltNode[] {
  return issues
    .filter((i) => i && Number.isFinite(i.number) && i.title)
    .map((i) => ({
      label: "Problem",
      props: {
        id: `gh-issue-${i.number}`,
        title: `#${i.number} ${i.title}`.slice(0, 120),
        description: (i.body ?? "").slice(0, 4000) || `GitHub issue (${i.state ?? "unknown"})`,
      },
    }));
}

/** Pure: GitHub pull requests → Decision nodes. */
export function pullsToNodes(pulls: GhPull[]): BuiltNode[] {
  return pulls
    .filter((p) => p && Number.isFinite(p.number) && p.title)
    .map((p) => ({
      label: "Decision",
      props: {
        id: `gh-pr-${p.number}`,
        title: `#${p.number} ${p.title}`.slice(0, 120),
        decision: (p.body ?? "").slice(0, 4000) || p.title,
        reasoning: `Pull request (${p.state ?? "unknown"})`,
      },
    }));
}

/** Pure: PR numbers referenced in a commit message (e.g. "fixes #42", "(#7)"). */
export function referencedPrNumbers(message: string): number[] {
  const out = new Set<number>();
  for (const m of message.matchAll(/#(\d+)/g)) out.add(Number(m[1]));
  return [...out];
}

export interface GitHubIngestResult {
  issues: number;
  pulls: number;
  links: number;
}

export async function ingestGitHub(
  memory: Memory,
  opts: { limit?: number; cwd?: string } = {},
): Promise<GitHubIngestResult> {
  const cwd = opts.cwd ?? process.cwd();
  const limit = opts.limit ?? 100;
  if (!(await isGhAvailable(cwd))) {
    throw new Error("GitHub CLI not available or not authenticated. Install `gh` and run `gh auth login`.");
  }

  const issues = JSON.parse(
    (await gh(["issue", "list", "--state", "all", "--limit", String(limit), "--json", "number,title,body,state"], cwd)) || "[]",
  ) as GhIssue[];
  const pulls = JSON.parse(
    (await gh(["pr", "list", "--state", "all", "--limit", String(limit), "--json", "number,title,body,state"], cwd)) || "[]",
  ) as GhPull[];

  for (const n of issuesToNodes(issues)) await memory.repo.upsertNode(n.label, n.props);
  const prNumbers = new Set<number>();
  for (const n of pullsToNodes(pulls)) {
    await memory.repo.upsertNode(n.label, n.props);
    prNumbers.add(Number(String(n.props.id).replace("gh-pr-", "")));
  }

  // Link commits → PRs (Decision) via #N references in commit messages.
  let links = 0;
  const commits = await memory.db.query(`MATCH (c:GitCommit) RETURN c.id AS id, c.message AS msg;`);
  for (const row of commits) {
    const msg = String(row.msg ?? "");
    for (const n of referencedPrNumbers(msg)) {
      if (!prNumbers.has(n)) continue;
      await memory.repo.relate("GitCommit", String(row.id), "IMPLEMENTS", "Decision", `gh-pr-${n}`);
      links++;
    }
  }

  return { issues: issues.length, pulls: pulls.length, links };
}
