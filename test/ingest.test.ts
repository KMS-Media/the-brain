import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/core.js";
import { ingest, scanStructure } from "../src/ingest/index.js";

let repo: string;
let store: string;
let mem: Memory;

/** Build a throwaway git repo with a known structure. */
before(async () => {
  repo = mkdtempSync(join(tmpdir(), "brain-repo-"));
  store = mkdtempSync(join(tmpdir(), "brain-store-"));
  mkdirSync(join(repo, "src", "db"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Test repo\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture-pkg" }));
  writeFileSync(join(repo, "src", "index.ts"), "export const x = 1;\n");
  writeFileSync(join(repo, "src", "db", "kuzu.ts"), "export class DB {}\n");

  const g = (args: string[]) => execFileSync("git", args, { cwd: repo });
  g(["init", "-q"]);
  g(["config", "user.email", "t@example.com"]);
  g(["config", "user.name", "Test"]);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "initial commit"]);

  mem = await Memory.openAt(store);
});

after(() => {
  mem?.close();
  for (const d of [repo, store]) if (d) rmSync(d, { recursive: true, force: true });
});

test("scanStructure materializes Project, Directory and File nodes", async () => {
  const res = await scanStructure(mem, repo);
  assert.equal(res.project, "fixture-pkg", "project name from package.json");
  assert.equal(res.files, 4, "four tracked files");
  // dirs: ".", "src", "src/db" → 3
  assert.equal(res.directories, 3, "three directories incl. root");

  const file = await mem.repo.getNode("File", "src/db/kuzu.ts");
  assert.ok(file, "file node exists");
  assert.equal(file!.language, "TypeScript");
  assert.ok(String(file!.checksum).length >= 7, "git blob checksum stored");
});

test("CONTAINS edges link project→dir and dir→file", async () => {
  // Project contains the src/db directory.
  const projDir = await mem.db.query(
    `MATCH (p:Project {id:'fixture-pkg'})-[:CONTAINS]->(d:Directory {id:'src/db'}) RETURN d.id AS id;`,
  );
  assert.equal(projDir.length, 1, "project → src/db");

  // src/db directory contains kuzu.ts.
  const dirFile = await mem.db.query(
    `MATCH (d:Directory {id:'src/db'})-[:CONTAINS]->(f:File) RETURN f.id AS id;`,
  );
  assert.deepEqual(dirFile.map((r) => r.id), ["src/db/kuzu.ts"]);

  // Root file is parented to ".".
  const rootFile = await mem.db.query(
    `MATCH (d:Directory {id:'.'})-[:CONTAINS]->(f:File {id:'README.md'}) RETURN f.id AS id;`,
  );
  assert.equal(rootFile.length, 1, "root file under '.'");
});

test("git history creates GitCommit nodes with MODIFIES edges", async () => {
  const res = await ingest(mem, repo, 10);
  assert.equal(res.git.commits, 1, "one commit");
  assert.ok(res.git.edges >= 4, "commit modifies all four files");

  const modified = await mem.db.query(
    `MATCH (c:GitCommit)-[:MODIFIES]->(f:File) RETURN count(f) AS n;`,
  );
  assert.ok(Number(modified[0].n) >= 4, "MODIFIES edges present");
});

test("ingest is idempotent (re-run does not duplicate)", async () => {
  await ingest(mem, repo, 10);
  await ingest(mem, repo, 10);
  const files = await mem.db.query(`MATCH (f:File) RETURN count(f) AS n;`);
  assert.equal(Number(files[0].n), 4, "still four files after re-ingest");
});
