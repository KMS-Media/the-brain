#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Memory } from "../core.js";
import { learn } from "../learning/extractor.js";
import { resolveStorageDir, ensureDir } from "../config.js";

/**
 * CLI for the_brain. Subcommands:
 *   init                         create/migrate the graph for this project
 *   query   "<text>"            print the assembled context block
 *   search  "<text>"            print ranked hits (JSON)
 *   component "<name>"          print a component view (JSON)
 *   learn   "<text>"            extract & store knowledge from text (or stdin)
 *   serve                        start the GraphQL server
 *   mcp                          start the MCP stdio server
 *   backup  [destDir]           copy the graph DB to a backup directory
 */

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "init": {
      const mem = await Memory.open();
      console.log(`Initialized memory at ${mem.db.storageDir}`);
      mem.close();
      break;
    }
    case "query":
    case "context": {
      const mem = await Memory.open();
      const ctx = await mem.context(rest.join(" "));
      console.log(ctx.markdown || ctx.summary);
      mem.close();
      break;
    }
    case "search": {
      const mem = await Memory.open();
      const hits = await mem.search(rest.join(" "));
      console.log(JSON.stringify(hits.map((h) => ({ ...h, props: { ...h.props, embedding: undefined } })), null, 2));
      mem.close();
      break;
    }
    case "component": {
      const mem = await Memory.open();
      console.log(JSON.stringify(await mem.component(rest.join(" ")), null, 2));
      mem.close();
      break;
    }
    case "learn": {
      const { isLLMEnabled } = await import("../llm.js");
      const mem = await Memory.open();
      const inputText = rest.length ? rest.join(" ") : await readStdin();
      const created = await learn(mem, inputText, { useLLM: isLLMEnabled() });
      console.log(`Stored ${created.length} item(s):`, created);
      mem.close();
      break;
    }
    case "ingest": {
      const { ingest } = await import("../ingest/index.js");
      const mem = await Memory.open();
      const limit = Number(rest[0]) || 100;
      const res = await ingest(mem, process.cwd(), limit);
      console.log(
        `Ingested project "${res.structure.project}": ` +
          `${res.structure.files} files, ${res.structure.directories} directories, ` +
          `${res.git.commits} commits, ${res.git.edges} commit→file edges.`,
      );
      mem.close();
      break;
    }
    case "github": {
      const { ingestGitHub } = await import("../github.js");
      const limArg = rest.find((a) => a.startsWith("--limit="));
      const limit = limArg ? Number(limArg.split("=")[1]) : 100;
      const mem = await Memory.open();
      try {
        const res = await ingestGitHub(mem, { limit });
        console.log(`GitHub: ingested ${res.issues} issue(s), ${res.pulls} PR(s), linked ${res.links} commit→PR edge(s).`);
      } catch (e) {
        console.error(String((e as Error).message));
        process.exitCode = 1;
      } finally {
        mem.close();
      }
      break;
    }
    case "projects": {
      const { listProjects } = await import("../multi.js");
      const projects = listProjects();
      if (projects.length === 0) {
        console.log("No project memories found under the memory home.");
      } else {
        for (const p of projects) console.log(`${p.name}\t${p.storageDir}`);
      }
      break;
    }
    case "xsearch": {
      const { searchAcrossProjects } = await import("../multi.js");
      const hits = await searchAcrossProjects(rest.join(" "));
      for (const h of hits) {
        const title = h.props.title ?? h.props.name ?? h.props.rule ?? h.props.problem ?? h.id;
        console.log(`[${h.project}] (${h.label}, ${h.score.toFixed(3)}) ${String(title)}`);
      }
      break;
    }
    case "transfer": {
      const { findProject, transferNode } = await import("../multi.js");
      const [fromName, toName, label, id] = rest;
      if (!fromName || !toName || !label || !id) {
        console.error("Usage: brain transfer <fromProject> <toProject> <Label> <id>");
        process.exit(1);
      }
      const from = findProject(fromName);
      const to = findProject(toName);
      if (!from) { console.error(`Project not found: ${fromName}`); process.exit(1); }
      if (!to) { console.error(`Project not found: ${toName}`); process.exit(1); }
      const res = await transferNode(from, to, label as never, id);
      console.log(`Transferred ${res.label}:${res.sourceId} from "${res.from}" to "${res.to}" as ${res.newId}.`);
      break;
    }
    case "share": {
      const sub = rest[0];
      const file = rest[1];
      if ((sub !== "export" && sub !== "import") || !file) {
        console.error("Usage: brain share export|import <file>");
        process.exit(1);
      }
      const { writeBundle, readAndImport } = await import("../share.js");
      const { backupPassphrase } = await import("../config.js");
      const mem = await Memory.open();
      if (sub === "export") {
        const res = await writeBundle(mem, file, backupPassphrase());
        console.log(`Shared ${res.nodes} nodes, ${res.edges} edges → ${file}${res.encrypted ? " (encrypted)" : ""}.`);
      } else {
        const res = await readAndImport(mem, file, backupPassphrase());
        console.log(`Imported ${res.nodes} nodes, ${res.edges} edges. Tip: run 'brain consolidate' to merge duplicates.`);
      }
      mem.close();
      break;
    }
    case "consolidate": {
      const { consolidate } = await import("../consolidate.js");
      const dryRun = rest.includes("--dry-run");
      const thArg = rest.find((a) => a.startsWith("--threshold="));
      const threshold = thArg ? Number(thArg.split("=")[1]) : undefined;
      const mem = await Memory.open();
      const report = await consolidate(mem, { dryRun, threshold });
      mem.close();
      console.log(
        `${dryRun ? "[dry-run] " : ""}Consolidation @ threshold ${report.threshold}: ` +
          `${report.clustersMerged} duplicate cluster(s), ${report.nodesRemoved} node(s) ` +
          `${dryRun ? "would be" : ""} merged.`,
      );
      for (const m of report.merges) console.log(`  ${m.label}: kept ${m.survivor}, merged ${m.merged.join(", ")}`);
      for (const s of report.skipped) console.log(`  (skipped ${s.label}: ${s.nodes} nodes > limit)`);
      break;
    }
    case "curate": {
      const { curate } = await import("../curate.js");
      const dryRun = rest.includes("--dry-run");
      const doPrune = rest.includes("--prune");
      const mem = await Memory.open();
      const r = await curate(mem, { dryRun, prune: doPrune });
      mem.close();
      console.log(
        `${dryRun ? "[dry-run] " : ""}Curation: merged ${r.consolidation.nodesRemoved} duplicate(s), ` +
          `promoted ${r.promoted.length} finding(s) to standards, pruned ${r.pruned.length} stale node(s).`,
      );
      for (const p of r.promoted) console.log(`  promoted: "${p.rule}" → standard ${p.standardId}`);
      break;
    }
    case "explore": {
      const { writeFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const { exportGraph, renderHtml } = await import("../explorer.js");
      const includeStructure = rest.includes("--all");
      const outArg = rest.find((a) => !a.startsWith("--"));
      const out = resolve(outArg ?? "brain-graph.html");
      const mem = await Memory.open();
      const data = await exportGraph(mem, { includeStructure });
      const html = renderHtml(data, resolveStorageDir().split("/").pop() ?? "project");
      mem.close();
      writeFileSync(out, html, "utf8");
      console.log(`Graph explorer written to ${out} (${data.nodes.length} nodes, ${data.edges.length} edges). Open it in a browser.`);
      break;
    }
    case "serve": {
      const { startGraphQLServer } = await import("../graphql/server.js");
      const { port } = await startGraphQLServer();
      console.log(`🧠 GraphQL on http://127.0.0.1:${port}/graphql`);
      break;
    }
    case "mcp": {
      const { createMcpServer, installProcessGuards } = await import("../mcp/server.js");
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      installProcessGuards();
      const server = await createMcpServer();
      await server.connect(new StdioServerTransport());
      console.error("🧠 the-brain MCP server running on stdio");
      break;
    }
    case "backup": {
      const { backupPassphrase } = await import("../config.js");
      const dir = resolveStorageDir();
      if (!existsSync(dir)) {
        console.error("No database to back up. Run `brain init` first.");
        process.exit(1);
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = rest[0] ? ensureDir(rest[0]) : ensureDir(join(dir, "backups"));
      const mem = await Memory.open();
      const res = await mem.backup(dest, stamp, backupPassphrase());
      mem.close();
      console.log(
        `Backup written to ${res.path} (${(res.bytes / 1024).toFixed(0)} KB, ` +
          `${res.encrypted ? "AES-256-GCM encrypted" : "plaintext — set BRAIN_BACKUP_KEY to encrypt"}).`,
      );
      break;
    }
    case "restore": {
      const { restoreDatabase } = await import("../backup.js");
      const { backupPassphrase } = await import("../config.js");
      const archive = rest[0];
      if (!archive) {
        console.error("Usage: brain restore <backup-file>");
        process.exit(1);
      }
      const dir = resolveStorageDir();
      restoreDatabase(archive, dir, backupPassphrase());
      console.log(`Restored ${archive} into ${dir}`);
      break;
    }
    default:
      console.log(
        [
          "the_brain — local memory for Claude Code",
          "",
          "Usage: brain <command> [args]",
          "  init                 create/migrate the graph for this project",
          '  query "<text>"       print the assembled context block',
          '  search "<text>"      print ranked hits (JSON)',
          '  component "<name>"   print a component view (JSON)',
          '  learn "<text>"       extract & store knowledge (markers: ADR/FINDING/LEARNED/RULE/NOTE)',
          "  ingest [gitLimit]    scan repo structure (files/dirs) + git history into the graph",
          "  github [--limit=N]   ingest GitHub issues (→Problem) and PRs (→Decision) via gh",
          "  projects             list all project memories under the memory home",
          '  xsearch "<text>"     search across ALL project memories',
          "  transfer <from> <to> <Label> <id>   copy a knowledge node between projects",
          "  explore [out.html] [--all]   export an interactive HTML graph (--all incl. files)",
          "  consolidate [--dry-run] [--threshold=0.95]   merge duplicate knowledge nodes",
          "  curate [--dry-run] [--prune]   maintenance agent: consolidate + promote findings + prune",
          "  share export|import <file>   share knowledge with a teammate (encrypted if BRAIN_BACKUP_KEY)",
          "  serve                start the GraphQL server",
          "  mcp                  start the MCP stdio server",
          "  backup [destDir]     archive the graph DB (AES-256-GCM if BRAIN_BACKUP_KEY is set)",
          "  restore <file>       restore a backup archive (needs BRAIN_BACKUP_KEY if encrypted)",
        ].join("\n"),
      );
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    if (process.stdin.isTTY) resolve("");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
