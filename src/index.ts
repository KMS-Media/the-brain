/** Public API surface for the_brain memory plugin. */
export { Memory } from "./core.js";
export { GraphDB } from "./db/kuzu.js";
export { Repository } from "./db/repo.js";
export { SearchEngine } from "./retrieval/search.js";
export { buildContext } from "./retrieval/contextBuilder.js";
export { extract, learn } from "./learning/extractor.js";
export { ingest, scanStructure, ingestGitHistory } from "./ingest/index.js";
export { listProjects, searchAcrossProjects, transferNode, findProject } from "./multi.js";
export { exportGraph, renderHtml } from "./explorer.js";
export { consolidate } from "./consolidate.js";
export { embed, cosine } from "./embeddings/embedder.js";
export * from "./types.js";
export * as config from "./config.js";
