import { homedir } from "node:os";
import { join, basename, resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

/**
 * Central configuration for the memory system.
 *
 * Security (PRD §17): everything stays local. No telemetry, no cloud.
 * Storage layout (PRD §18):
 *   - global default: ~/.claude-memory/<project-slug>/
 *   - project-local:  <project>/.project-memory/   (when BRAIN_PROJECT_LOCAL=1)
 */

export const EMBEDDING_MODEL = process.env.BRAIN_EMBEDDING_MODEL ?? "Xenova/bge-small-en-v1.5";
export const EMBEDDING_DIM = Number(process.env.BRAIN_EMBEDDING_DIM ?? 384);
/** Embedding scheme version (PRD §15). Bump when model/preprocessing changes so stale vectors can be re-embedded. */
export const EMBEDDING_VERSION = process.env.BRAIN_EMBEDDING_VERSION ?? "1";

/** Token budget for the assembled context (PRD §12). Rough char≈token/4 heuristic. */
export const CONTEXT_TOKEN_BUDGET = Number(process.env.BRAIN_TOKEN_BUDGET ?? 1500);

/**
 * Max database size in bytes (must be a power of 2). Kuzu reserves this much
 * virtual address space per open Database via mmap; the default (8 TiB) is so
 * large that opening many stores in one process (e.g. cross-project search)
 * exhausts the address space. 4 GiB is ample for a 100k-node / 1M-edge graph.
 */
export const MAX_DB_SIZE = Number(process.env.BRAIN_MAX_DB_SIZE ?? 4 * 1024 * 1024 * 1024);

/**
 * Buffer-pool size in bytes per open database. Kuzu otherwise sizes this to
 * ~80% of physical RAM *per Database*, which exhausts memory when several
 * stores are open at once (cross-project search, CI runners). 256 MiB
 * comfortably holds a 100k-node working set while letting many stores coexist.
 */
export const BUFFER_POOL_SIZE = Number(process.env.BRAIN_BUFFER_POOL ?? 256 * 1024 * 1024);

/** GraphQL server port. */
export const GRAPHQL_PORT = Number(process.env.BRAIN_GRAPHQL_PORT ?? 4123);

/** Passphrase for encrypting backups (PRD §17). Unset → backups are plaintext archives. */
export function backupPassphrase(): string | undefined {
  const k = process.env.BRAIN_BACKUP_KEY;
  return k && k.length > 0 ? k : undefined;
}

/**
 * Optional local LLM (PRD §21 V2). Points at an OpenAI-compatible chat endpoint
 * served locally — e.g. Ollama (`http://localhost:11434/v1`) or llama.cpp. Stays
 * fully local; unset → all LLM features gracefully no-op and fall back to the
 * deterministic heuristics.
 */
export interface LLMConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export function llmConfig(): LLMConfig | null {
  const baseUrl = process.env.BRAIN_LLM_URL;
  if (!baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    model: process.env.BRAIN_LLM_MODEL ?? "llama3.2",
    apiKey: process.env.BRAIN_LLM_KEY,
  };
}

function slug(p: string): string {
  return basename(p).replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}

/** Resolve the directory where the Kuzu database for a given project lives. */
export function resolveStorageDir(projectPath: string = process.cwd()): string {
  const abs = resolve(projectPath);
  if (process.env.BRAIN_PROJECT_LOCAL === "1") {
    return join(abs, ".project-memory");
  }
  const base = process.env.BRAIN_HOME ?? join(homedir(), ".claude-memory");
  return join(base, slug(abs));
}

/** Path to the Kuzu database directory inside a storage dir. */
export function dbPath(storageDir: string): string {
  return join(storageDir, "graph.kuzu");
}

/**
 * Where embedding models are cached. Intentionally GLOBAL (a fixed home dir),
 * decoupled from BRAIN_HOME: the model is large and shared across every
 * project/store, so a custom or throwaway BRAIN_HOME must not trigger a
 * re-download. Override only via BRAIN_MODEL_CACHE.
 */
export function modelCacheDir(): string {
  return process.env.BRAIN_MODEL_CACHE ?? join(homedir(), ".claude-memory", "models");
}

export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
