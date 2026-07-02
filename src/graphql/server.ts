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
export async function startGraphQLServer(opts: { port?: number; projectPath?: string } = {}): Promise<{ port: number; stop: () => Promise<void> }> {
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
    // stop() is exported API: the caller's process may keep running afterwards,
    // so the native Kuzu handle must actually be freed (disposeSafely), not just
    // the advisory lock (close) — otherwise the store stays locked for other
    // processes until this one exits. Awaiting server.close() first also keeps
    // in-flight resolvers from using the Memory after teardown.
    stop: async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await memory.disposeSafely();
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
