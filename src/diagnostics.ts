import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensureDir } from "./config.js";

/**
 * Best-effort forensic trail for the long-lived MCP server process.
 *
 * Segfaults and OOM kills are native process deaths — no JS handler (uncaughtException,
 * unhandledRejection, process.on("exit")) ever runs for them, so the only way to learn
 * anything post-mortem is to have already written a breadcrumb *before* the fatal
 * operation. This is deliberately synchronous (appendFileSync): an async write could
 * still be in flight, and therefore lost, at the moment the process dies.
 */
const LOG_PATH = process.env.BRAIN_CRASH_LOG ?? join(process.env.BRAIN_HOME ?? join(homedir(), ".claude-memory"), "mcp-crash.log");

export function logBreadcrumb(event: string, details: Record<string, unknown> = {}): void {
  try {
    ensureDir(dirname(LOG_PATH));
    const line = JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...details });
    appendFileSync(LOG_PATH, line + "\n");
  } catch {
    // Diagnostics must never be the reason the server fails.
  }
}
