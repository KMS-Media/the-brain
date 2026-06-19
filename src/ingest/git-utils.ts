import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/** Run a git command in `cwd`, returning stdout (empty string on failure). */
export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await pexec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return "";
  }
}

/** True if `cwd` is inside a git work tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const out = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return out.trim() === "true";
}
