import { createServer } from "node:http";
import { createYoga } from "graphql-yoga";
import { Memory } from "../core.js";
import { makeSchema, type GraphQLContext } from "./schema.js";
import { GRAPHQL_PORT } from "../config.js";

/**
 * Local GraphQL server (PRD §8). Binds to 127.0.0.1 only — never exposed to
 * the network (PRD §17 fully local). One shared Memory instance lives for the
 * process lifetime and is injected into every resolver via context.
 */
export async function startGraphQLServer(opts: { port?: number; projectPath?: string } = {}): Promise<{ port: number; stop: () => void }> {
  const memory = await Memory.open(opts.projectPath);
  const yoga = createYoga<{}, GraphQLContext>({
    schema: makeSchema(),
    context: async () => ({ memory }),
    graphqlEndpoint: "/graphql",
    landingPage: false,
  });

  const server = createServer(yoga);
  const port = opts.port ?? GRAPHQL_PORT;
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port,
    stop: () => {
      server.close();
      memory.close();
    },
  };
}

// Allow `tsx src/graphql/server.ts` / `npm run serve`.
if (import.meta.url === `file://${process.argv[1]}`) {
  startGraphQLServer()
    .then(({ port }) => console.log(`🧠 the_brain GraphQL on http://127.0.0.1:${port}/graphql`))
    .catch((err) => {
      console.error("Failed to start GraphQL server:", err);
      process.exit(1);
    });
}
