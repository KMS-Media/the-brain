import { GraphDB } from "./db/kuzu.js";
import { Repository } from "./db/repo.js";
import { SearchEngine } from "./retrieval/search.js";
import { buildContext } from "./retrieval/contextBuilder.js";
import type { MemoryContext, NodeLabel, ScoredNode } from "./types.js";

/**
 * The Memory facade. Every interface (MCP tools, GraphQL resolvers, CLI, the
 * prompt hook) goes through this single object so behavior stays consistent.
 */
export class Memory {
  private constructor(
    readonly db: GraphDB,
    readonly repo: Repository,
    readonly engine: SearchEngine,
  ) {}

  static async open(projectPath?: string): Promise<Memory> {
    const db = await GraphDB.open(projectPath);
    return new Memory(db, new Repository(db), new SearchEngine(db));
  }

  static async openAt(storageDir: string): Promise<Memory> {
    const db = await GraphDB.openAt(storageDir);
    return new Memory(db, new Repository(db), new SearchEngine(db));
  }

  /** Raw ranked search hits (PRD §8 search query). */
  async search(query: string, limit = 20): Promise<ScoredNode[]> {
    return this.engine.search(query, { limit });
  }

  /**
   * Assemble a prioritized, deduplicated, budgeted context block
   * (PRD §8 context query, §11 priority, §12 builder). Bumps usage counts
   * for surfaced nodes (PRD §10 usage signal, §14 learning loop).
   */
  async context(query: string, limit = 30): Promise<MemoryContext> {
    const ranked = await this.engine.search(query, { limit });
    const { context, used } = buildContext(query, ranked);
    // Usage feedback: surfaced nodes become slightly more retrievable next time.
    const byLabel = new Map<NodeLabel, string[]>();
    for (const u of used) {
      const arr = byLabel.get(u.label) ?? [];
      arr.push(u.id);
      byLabel.set(u.label, arr);
    }
    for (const [label, ids] of byLabel) await this.repo.bumpUsage(label, ids);
    return context;
  }

  /**
   * Component lookup (PRD §8 component query): decisions, dependencies,
   * findings and experiences related to a named component.
   */
  async component(name: string): Promise<{
    component: Record<string, unknown> | null;
    decisions: Record<string, unknown>[];
    dependencies: Record<string, unknown>[];
    findings: Record<string, unknown>[];
    experiences: Record<string, unknown>[];
  }> {
    const compRows = await this.db.query(`MATCH (c:Component {name: $name}) RETURN c;`, { name });
    const component = (compRows[0]?.c as Record<string, unknown> | undefined) ?? null;
    if (!component) {
      return { component: null, decisions: [], dependencies: [], findings: [], experiences: [] };
    }
    const id = component.id as string;
    const unwrap = (rows: Record<string, unknown>[], key: string) =>
      rows.map((r) => r[key] as Record<string, unknown>);

    const [decisions, dependencies, findings, experiences] = await Promise.all([
      this.db.query(`MATCH (d:Decision)-[:AFFECTS]->(c:Component {id: $id}) RETURN d;`, { id }),
      this.db.query(
        `MATCH (c:Component {id: $id})-[:USES|CALLS|DEPENDS_ON]->(o:Component) RETURN DISTINCT o;`,
        { id },
      ),
      this.db.query(`MATCH (f:ReviewFinding)-[:AFFECTS]->(c:Component {id: $id}) RETURN f;`, { id }),
      this.db.query(`MATCH (e:Experience)-[:RELATES_TO]->(c:Component {id: $id}) RETURN e;`, { id }),
    ]);

    return {
      component,
      decisions: unwrap(decisions, "d"),
      dependencies: unwrap(dependencies, "o"),
      findings: unwrap(findings, "f"),
      experiences: unwrap(experiences, "e"),
    };
  }

  close(): void {
    this.db.close();
  }
}
