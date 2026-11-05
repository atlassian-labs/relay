export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed";

export type DiffFile = {
  path: string;
  oldPath?: string;
  patch: string;
  additions: number;
  deletions: number;
  status: DiffFileStatus;
};

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

function headerPath(line: string): string | undefined {
  const match = /^(?:---|\+\+\+)\s+(\S+)/.exec(line);
  const value = match?.[1];
  if (!value || value === "/dev/null") return undefined;
  return stripPrefix(value);
}

export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const normalized = diffText.replace(/\r\n/g, "\n");
  const chunks = normalized.split(/(?=^diff --git\s+)/m).filter(Boolean);

  return chunks.flatMap((patch) => {
    const lines = patch.split("\n");
    if (!lines[0]?.startsWith("diff --git ")) return [];

    let additions = 0;
    let deletions = 0;
    let status: DiffFileStatus = "modified";
    let oldPath: string | undefined;
    let newPath: string | undefined;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;

    for (const line of lines) {
      if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "deleted";
      else if (line.startsWith("rename from ")) {
        status = "renamed";
        renameFrom = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) {
        status = "renamed";
        renameTo = line.slice("rename to ".length);
      } else if (line.startsWith("--- ")) oldPath = headerPath(line);
      else if (line.startsWith("+++ ")) newPath = headerPath(line);
      else if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }

    const path = renameTo ?? newPath ?? oldPath ?? lines[0].split(" ")[3]?.replace(/^b\//, "");
    if (!path) return [];
    return [{ path, oldPath: renameFrom ?? oldPath, patch, additions, deletions, status }];
  });
}
