export const LANG_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".rb": "ruby",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "c_sharp",
  ".swift": "swift",
  ".kt": "kotlin",
  ".lua": "lua",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".html": "html",
  ".css": "css",
  ".scss": "css",
  ".md": "markdown",
  ".sql": "sql",
  ".graphql": "graphql",
  ".dockerfile": "dockerfile",
  ".tf": "hcl",
  ".zig": "zig",
};

export function getFiletype(ext: string): string {
  return LANG_EXT[ext.toLowerCase()] ?? "none";
}

export * as Filetype from "./filetype";
