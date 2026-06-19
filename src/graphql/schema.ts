import { createSchema } from "graphql-yoga";
import { JSONResolver } from "graphql-scalars";
import type { Memory } from "../core.js";

export interface GraphQLContext {
  memory: Memory;
}

/**
 * GraphQL API (PRD §8). Queries: search, context, component.
 * Mutations let Claude (or tooling) persist each knowledge type, plus a
 * free-text `learn` endpoint that runs the heuristic extractor (§14).
 */
const typeDefs = /* GraphQL */ `
  scalar JSON

  type ScoreBreakdown {
    semantic: Float!
    graph: Float!
    importance: Float!
    usage: Float!
    recency: Float!
  }

  type SearchHit {
    label: String!
    id: String!
    score: Float!
    props: JSON!
    breakdown: ScoreBreakdown!
  }

  type MemoryContext {
    summary: String!
    findings: [String!]!
    standards: [String!]!
    decisions: [String!]!
    architecture: [String!]!
    experiences: [String!]!
    knowledge: [String!]!
    markdown: String!
  }

  type ComponentView {
    component: JSON
    decisions: [JSON!]!
    dependencies: [JSON!]!
    findings: [JSON!]!
    experiences: [JSON!]!
  }

  type Created {
    label: String!
    id: String!
  }

  type Query {
    search(query: String!, limit: Int = 20): [SearchHit!]!
    context(query: String!, limit: Int = 30): MemoryContext!
    component(name: String!): ComponentView!
  }

  type Mutation {
    rememberKnowledge(title: String!, content: String!, tags: [String!], importance: Float): Created!
    rememberDecision(title: String!, problem: String, decision: String!, reasoning: String, alternatives: String): Created!
    rememberExperience(problem: String!, solution: String!, outcome: String, confidence: Float): Created!
    rememberReviewFinding(rule: String!, severity: String, category: String, example: String, fix: String): Created!
    rememberStandard(name: String!, description: String!, examples: String): Created!
    rememberComponent(name: String!, type: String, description: String): Created!
    relate(fromLabel: String!, fromId: String!, relType: String!, toLabel: String!, toId: String!): Boolean!
    learn(text: String!): [Created!]!
  }
`;

export function makeSchema() {
  return createSchema<GraphQLContext>({
    typeDefs,
    resolvers: {
      JSON: JSONResolver,
      Query: {
        search: async (_p, args: { query: string; limit?: number }, ctx) => {
          const hits = await ctx.memory.search(args.query, args.limit ?? 20);
          return hits.map((h) => ({ label: h.label, id: h.id, score: h.score, props: h.props, breakdown: h.breakdown }));
        },
        context: async (_p, args: { query: string; limit?: number }, ctx) => {
          return ctx.memory.context(args.query, args.limit ?? 30);
        },
        component: async (_p, args: { name: string }, ctx) => {
          return ctx.memory.component(args.name);
        },
      },
      Mutation: {
        rememberKnowledge: (_p, args, ctx) => upsert(ctx, "Knowledge", args),
        rememberDecision: (_p, args, ctx) => upsert(ctx, "Decision", args),
        rememberExperience: (_p, args, ctx) => upsert(ctx, "Experience", args),
        rememberReviewFinding: (_p, args, ctx) => upsert(ctx, "ReviewFinding", { frequency: 1, ...args }),
        rememberStandard: (_p, args, ctx) => upsert(ctx, "CodingStandard", args),
        rememberComponent: (_p, args, ctx) => upsert(ctx, "Component", args),
        relate: async (_p, args: { fromLabel: string; fromId: string; relType: string; toLabel: string; toId: string }, ctx) => {
          await ctx.memory.repo.relate(args.fromLabel as never, args.fromId, args.relType, args.toLabel as never, args.toId);
          return true;
        },
        learn: async (_p, args: { text: string }, ctx) => {
          const { learn } = await import("../learning/extractor.js");
          return learn(ctx.memory, args.text);
        },
      },
    },
  });
}

async function upsert(ctx: GraphQLContext, label: string, args: Record<string, unknown>) {
  const { id } = await ctx.memory.repo.upsertNode(label as never, args);
  return { label, id };
}
