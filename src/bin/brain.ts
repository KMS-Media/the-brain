#!/usr/bin/env node
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Memory } from "../core.js";
import { learn } from "../learning/extractor.js";
import { resolveStorageDir, dbPath, ensureDir } from "../config.js";

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
      const mem = await Memory.open();
      const inputText = rest.length ? rest.join(" ") : await readStdin();
      const created = await learn(mem, inputText);
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
    case "serve": {
      const { startGraphQLServer } = await import("../graphql/server.js");
      const { port } = await startGraphQLServer();
      console.log(`🧠 GraphQL on http://127.0.0.1:${port}/graphql`);
      break;
    }
    case "mcp": {
      const { createMcpServer } = await import("../mcp/server.js");
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const server = await createMcpServer();
      await server.connect(new StdioServerTransport());
      console.error("🧠 the-brain MCP server running on stdio");
      break;
    }
    case "backup": {
      const dir = resolveStorageDir();
      const src = dbPath(dir);
      if (!existsSync(src)) {
        console.error("No database to back up. Run `brain init` first.");
        process.exit(1);
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = rest[0] ? ensureDir(rest[0]) : ensureDir(join(dir, "backups"));
      const target = join(dest, `graph-${stamp}.kuzu`);
      cpSync(src, target, { recursive: true });
      console.log(`Backup written to ${target}`);
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
          "  serve                start the GraphQL server",
          "  mcp                  start the MCP stdio server",
          "  backup [destDir]     copy the graph DB to a backup directory",
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
