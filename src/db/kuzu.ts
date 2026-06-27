import * as kuzu from "kuzu";
import { dbPath, ensureDir, resolveStorageDir, MAX_DB_SIZE, BUFFER_POOL_SIZE } from "../config.js";
import { ALL_DDL, MIGRATIONS } from "./schema.js";
import { acquireLock, type LockHandle } from "./lock.js";

/**
 * Thin async wrapper around the Kuzu embedded graph database.
 *
 * Verified API (Kuzu 0.11.3):
 *   new kuzu.Database(path) / new kuzu.Connection(db)
 *   await conn.query(cypher)               -> QueryResult
 *   await conn.prepare(cypher)             -> PreparedStatement
 *   await conn.execute(stmt, paramsObject) -> QueryResult
 *   await result.getAll()                  -> Record<string, any>[]
 * Array params (FLOAT[N], STRING[]) bind from JS arrays. `array_cosine_similarity`
 * is available natively.
 */
/** Kuzu allows only one read-write process per database file at a time. */
function isLockError(e: unknown): boolean {
  return /lock|IO exception/i.test(String((e as Error)?.message ?? e));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GraphDB {
  readonly storageDir: string;
  private db: kuzu.Database;
  private conn: kuzu.Connection;
  private lock: LockHandle;

  /** Storage dirs already migrated in THIS process — skip the idempotent DDL on reopen. */
  private static migrated = new Set<string>();

  private constructor(storageDir: string, lock: LockHandle) {
    this.storageDir = storageDir;
    this.lock = lock;
    // Args: path, bufferManagerSize, enableCompression, readOnly, maxDBSize.
    // Capping both the buffer pool (else ~80% RAM per Database) and maxDBSize
    // (else an 8 TiB mmap reservation) keeps each store's footprint modest so
    // many can be open at once (cross-project search, constrained CI runners).
    this.db = new kuzu.Database(dbPath(storageDir), BUFFER_POOL_SIZE, undefined, undefined, MAX_DB_SIZE);
    this.conn = new kuzu.Connection(this.db);
  }

  /** Open (and create+migrate) the database for a project path. */
  static async open(projectPath?: string): Promise<GraphDB> {
    return GraphDB.openAt(resolveStorageDir(projectPath));
  }

  /**
   * Open at an explicit storage directory. Access across processes is serialized
   * by a cooperative lockfile (see lock.ts), so the long-lived MCP server, the
   * prompt hooks and the CLI never collide on Kuzu's single-writer file. A small
   * Kuzu-level retry remains as a safety net for any residual races.
   */
  static async openAt(storageDir: string, retries = 8): Promise<GraphDB> {
    ensureDir(storageDir);
    const lock = await acquireLock(storageDir);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let g: GraphDB;
      try {
        g = new GraphDB(storageDir, lock);
        await g.migrate();
        return g;
      } catch (e) {
        lastErr = e;
        try {
          (g! as GraphDB | undefined)?.disposeKuzu();
        } catch {
          /* ignore */
        }
        if (isLockError(e) && attempt < retries) {
          await sleep(Math.min(400, 60 * (attempt + 1)) + Math.floor(Math.random() * 60));
          continue;
        }
        lock.release(); // give up — don't leak the lockfile
        throw e;
      }
    }
    lock.release();
    throw lastErr;
  }

  /** Run all DDL idempotently, then apply column migrations for older DBs. */
  async migrate(): Promise<void> {
    if (GraphDB.migrated.has(this.storageDir)) {
      // Touch the connection so a stale lock still surfaces here (and is retried).
      await this.run("RETURN 1;");
      return;
    }
    for (const ddl of ALL_DDL) {
      await this.run(ddl);
    }
    for (const stmt of MIGRATIONS) {
      try {
        await this.run(stmt);
      } catch {
        // Best-effort: a missing table (never created) or unsupported clause is non-fatal.
      }
    }
    GraphDB.migrated.add(this.storageDir);
  }

  /** Execute a raw Cypher statement with no parameters. */
  async run(cypher: string): Promise<Record<string, unknown>[]> {
    const result = await this.conn.query(cypher);
    return this.collect(result);
  }

  /** Execute a parameterized Cypher statement. */
  async query(cypher: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
    if (Object.keys(params).length === 0) return this.run(cypher);
    const stmt = await this.conn.prepare(cypher);
    // Kuzu's typings narrow params to KuzuValue; our values are validated at the
    // repository layer, so cast through the binding's expected shape.
    const result = await this.conn.execute(stmt, params as Record<string, never>);
    return this.collect(result);
  }

  private async collect(result: unknown): Promise<Record<string, unknown>[]> {
    // QueryResult (or array of them for multi-statement). We only ever run one.
    const r = Array.isArray(result) ? result[result.length - 1] : result;
    const rows = await (r as { getAll(): Promise<Record<string, unknown>[]> }).getAll();
    return rows;
  }

  /**
   * Flush the write-ahead log into the main database file. Required before
   * copying the files for a backup — uncheckpointed data lives only in the WAL
   * and would be missing from a raw file copy.
   */
  async checkpoint(): Promise<void> {
    await this.run("CHECKPOINT;");
  }

  /**
   * Close the database and release the cross-process lock. Identical to
   * dispose() — every caller must release the lockfile it acquired in openAt(),
   * otherwise a later open of the same store (even in the same process, e.g.
   * cross-project search) would deadlock on the lock.
   */
  close(): void {
    this.dispose();
  }

  /** Close the Kuzu handles only (not the cross-process lock). */
  private disposeKuzu(): void {
    try {
      (this.conn as { closeSync?: () => void }).closeSync?.();
    } catch {
      /* already closed */
    }
    try {
      (this.db as { closeSync?: () => void }).closeSync?.();
    } catch {
      /* already closed */
    }
  }

  /**
   * Really close the database AND release the cross-process lockfile. A
   * long-lived holder (the MCP server) must call this after each operation so
   * the prompt hooks and the CLI can take their turn — Kuzu allows only one
   * read-write process per file.
   */
  dispose(): void {
    try {
      this.disposeKuzu();
    } catch {
      // Kuzu/ONNX native destructors are known to throw or abort during close.
      // The lock MUST be released regardless — a leaked lock blocks every
      // other process (hooks, MCP, CLI) for up to STALE_MS.
    }
    this.lock.release();
  }
}
