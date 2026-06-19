import { resolve, basename, dirname, posix } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Memory } from "../core.js";
import { git, isGitRepo } from "./git-utils.js";
import { detectLanguage } from "./language.js";

/**
 * Structural auto-ingestion (PRD §6/§7, structural half):
 * scans the git work tree and materializes the project structure as graph
 * nodes — Project, Directory, File — with CONTAINS edges:
 *
 *   (Project)-[:CONTAINS]->(Directory)      // every directory, flat
 *   (Directory)-[:CONTAINS]->(File)         // immediate parent → file
 *
 * Tracked files come from `git ls-files` (so .gitignore is honored for free),
 * and each File's checksum is the git blob hash from `git ls-files -s` — no
 * file content is read, keeping the scan fast on large repos. Files in the
 * repo root are parented to a synthetic root directory with path ".".
 */

export interface ScanResult {
  project: string;
  files: number;
  directories: number;
}

const ROOT_DIR = ".";

/** Determine a stable, human-readable project name. */
function projectName(projectPath: string): string {
  const pkgPath = join(projectPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
      if (pkg.name) return pkg.name;
    } catch {
      /* ignore malformed package.json */
    }
  }
  return basename(resolve(projectPath));
}

/** Parse `git ls-files -s` lines: "<mode> <blobhash> <stage>\t<path>". */
function parseLsFiles(stdout: string): { path: string; checksum: string }[] {
  const out: { path: string; checksum: string }[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const meta = line.slice(0, tab).split(/\s+/); // [mode, blobhash, stage]
    const path = line.slice(tab + 1).trim();
    if (path) out.push({ path: path.split("\\").join("/"), checksum: meta[1] ?? "" });
  }
  return out;
}

/** All ancestor directories of a posix file path, including the root ".". */
function ancestorDirs(filePath: string): string[] {
  const dirs = new Set<string>([ROOT_DIR]);
  let d = posix.dirname(filePath);
  while (d && d !== "." && d !== "/") {
    dirs.add(d);
    d = posix.dirname(d);
  }
  return [...dirs];
}

/** Immediate parent directory of a posix file path ("." for root files). */
function parentDir(filePath: string): string {
  const d = posix.dirname(filePath);
  return d === "." ? ROOT_DIR : d;
}

export async function scanStructure(memory: Memory, projectPath: string = process.cwd()): Promise<ScanResult> {
  const root = resolve(projectPath);
  if (!(await isGitRepo(root))) {
    throw new Error(`Not a git repository: ${root}. Structural ingestion uses 'git ls-files'.`);
  }

  const name = projectName(root);
  await memory.repo.upsertNode("Project", { id: name, name, description: `Auto-ingested from ${root}` });

  const files = parseLsFiles(await git(root, ["ls-files", "-s"]));

  // 1. Collect all directories across all files.
  const allDirs = new Set<string>();
  for (const f of files) for (const d of ancestorDirs(f.path)) allDirs.add(d);

  // 2. Upsert directories and link Project → Directory.
  for (const dir of allDirs) {
    await memory.repo.upsertNode("Directory", { id: dir, path: dir });
    await memory.repo.relate("Project", name, "CONTAINS", "Directory", dir);
  }

  // 3. Upsert files and link parent Directory → File.
  for (const f of files) {
    await memory.repo.upsertNode("File", {
      id: f.path,
      path: f.path,
      language: detectLanguage(f.path),
      checksum: f.checksum,
    });
    await memory.repo.relate("Directory", parentDir(f.path), "CONTAINS", "File", f.path);
  }

  return { project: name, files: files.length, directories: allDirs.size };
}
