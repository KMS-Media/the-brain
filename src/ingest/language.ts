import { extname, basename } from "node:path";

/** Map a file path to a coarse language label for the File node. */
const BY_EXT: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".json": "JSON",
  ".md": "Markdown",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".c": "C",
  ".h": "C",
  ".cpp": "C++",
  ".cc": "C++",
  ".hpp": "C++",
  ".sql": "SQL",
  ".sh": "Shell",
  ".bash": "Shell",
  ".zsh": "Shell",
  ".yml": "YAML",
  ".yaml": "YAML",
  ".toml": "TOML",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "SCSS",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".graphql": "GraphQL",
  ".gql": "GraphQL",
};

const BY_NAME: Record<string, string> = {
  Dockerfile: "Dockerfile",
  Makefile: "Makefile",
  ".gitignore": "Config",
  ".npmrc": "Config",
};

export function detectLanguage(path: string): string {
  const name = basename(path);
  if (BY_NAME[name]) return BY_NAME[name];
  const ext = extname(path).toLowerCase();
  return BY_EXT[ext] ?? "Other";
}
