# Acknowledgments

the_brain is built on the shoulders of several excellent open-source projects.
We are grateful to their authors and contributors.

---

## Core Dependencies

### Kuzu
**Embedded graph database**
- Repository: https://github.com/kuzudb/kuzu
- License: MIT
- Used for: persistent graph storage of all memory nodes and relationships.

### @huggingface/transformers
**Local ONNX inference runtime**
- Repository: https://github.com/huggingface/transformers.js
- License: Apache 2.0
- Used for: running the embedding model locally via ONNX Runtime.

### BGE-Small-en-v1.5 (Embedding Model)
**Sentence embedding model**
- Author: Beijing Academy of Artificial Intelligence (BAAI)
- Source: https://huggingface.co/BAAI/bge-small-en-v1.5
- License: MIT
- Used for: generating 384-dimensional semantic embeddings for similarity search.

### @modelcontextprotocol/sdk
**MCP stdio transport and server primitives**
- Repository: https://github.com/modelcontextprotocol/typescript-sdk
- Author: Anthropic
- License: MIT
- Used for: exposing memory tools to Claude Code via the Model Context Protocol.

### graphql + graphql-yoga + graphql-scalars
**GraphQL server stack**
- graphql: https://github.com/graphql/graphql-js — MIT
- graphql-yoga: https://github.com/dotansimha/graphql-yoga — MIT (The Guild)
- graphql-scalars: https://github.com/Urigo/graphql-scalars — MIT (The Guild)
- Used for: the optional local GraphQL API on `127.0.0.1:4123`.

### Zod
**Runtime schema validation**
- Repository: https://github.com/colinhacks/zod
- License: MIT
- Used for: validating MCP tool inputs and structured data.

---

## Development Dependencies

### TypeScript
- Repository: https://github.com/microsoft/TypeScript
- License: Apache 2.0

### tsx
- Repository: https://github.com/privatenumber/tsx
- License: MIT

---

## Platform

### Claude Code
the_brain is designed as a plugin for **Claude Code** by Anthropic.
The hook system, MCP integration, and plugin manifest format are all part of
the Claude Code extension API.

- https://claude.ai/code
- © Anthropic, PBC

---

## License

the_brain itself is released under the **GNU Affero General Public License v3.0
or later** (AGPL-3.0-or-later). See [LICENSE](./LICENSE) for the full text.
