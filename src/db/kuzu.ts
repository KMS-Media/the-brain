import * as kuzu from "kuzu";
import { dbPath, ensureDir, resolveStorageDir, MAX_DB_SIZE, BUFFER_POOL_SIZE } from "../config.js";
import { ALL_DDL, MIGRATIONS } from "./schema.js";

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
export class GraphDB {
  readonly storageDir: string;
  private db: kuzu.Database;
  private conn: kuzu.Connection;

  private constructor(storageDir: string) {
    this.storageDir = storageDir;
    ensureDir(storageDir);
    // Args: path, bufferManagerSize, enableCompression, readOnly, maxDBSize.
    // Capping both the buffer pool (else ~80% RAM per Database) and maxDBSize
    // (else an 8 TiB mmap reservation) keeps each store's footprint modest so
    // many can be open at once (cross-project search, constrained CI runners).
    this.db = new kuzu.Database(dbPath(storageDir), BUFFER_POOL_SIZE, undefined, undefined, MAX_DB_SIZE);
    this.conn = new kuzu.Connection(this.db);
  }

  /** Open (and create+migrate) the database for a project path. */
  static async open(projectPath?: string): Promise<GraphDB> {
    const dir = resolveStorageDir(projectPath);
    const g = new GraphDB(dir);
    await g.migrate();
    return g;
  }

  /** Open at an explicit storage directory (used by tests). */
  static async openAt(storageDir: string): Promise<GraphDB> {
    const g = new GraphDB(storageDir);
    await g.migrate();
    return g;
  }

  /** Run all DDL idempotently, then apply column migrations for older DBs. */
  async migrate(): Promise<void> {
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
   * No-op: Kuzu releases native resources on GC / process exit. (Calling the
   * binding's synchronous close() while other handles are live can crash the
   * native layer, so we deliberately don't.) Always checkpoint() before relying
   * on the on-disk file being current.
   */
  close(): void {}
}
