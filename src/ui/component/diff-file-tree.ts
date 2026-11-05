import type { DiffFile, DiffFileStatus } from "../../core/diff-utils";

export type DiffFileTreeNode = {
  readonly id: number;
  readonly name: string;
  readonly parent: number | undefined;
  readonly children: number[];
  readonly depth: number;
  readonly kind: "directory" | "file";
  readonly fileIndex?: number;
};

export type DiffFileTree = {
  readonly roots: number[];
  readonly nodes: DiffFileTreeNode[];
};

export type DiffFileTreeRow = {
  readonly id: number;
  readonly depth: number;
  readonly kind: "directory" | "file";
  readonly name: string;
  readonly fileIndex?: number;
};

export function buildDiffFileTree(files: readonly DiffFile[]): DiffFileTree {
  const roots: number[] = [];
  const nodes: DiffFileTreeNode[] = [];
  const directoryByPath = new Map<string, number>();

  files.forEach((file, fileIndex) => {
    const segments = file.path.split("/").filter(Boolean);
    if (segments.length === 0) return;

    const parent = segments.slice(0, -1).reduce(
      (state, segment) => {
        const directoryPath = state.path ? `${state.path}/${segment}` : segment;
        const existing = directoryByPath.get(directoryPath);
        if (existing !== undefined) return { id: existing, path: directoryPath, depth: state.depth + 1 };

        const id = addDiffFileTreeNode(nodes, roots, {
          name: segment,
          parent: state.id,
          depth: state.depth,
          kind: "directory",
        });
        directoryByPath.set(directoryPath, id);
        return { id, path: directoryPath, depth: state.depth + 1 };
      },
      { id: undefined as number | undefined, path: "", depth: 0 },
    );

    addDiffFileTreeNode(nodes, roots, {
      name: segments[segments.length - 1]!,
      parent: parent.id,
      depth: parent.depth,
      kind: "file",
      fileIndex,
    });
  });

  const tree = { roots, nodes };
  tree.roots.sort((left, right) => compareDiffFileTreeNodes(tree, left, right));
  tree.nodes.forEach((node) => node.children.sort((left, right) => compareDiffFileTreeNodes(tree, left, right)));
  return tree;
}

export function flattenDiffFileTree(tree: DiffFileTree, expanded?: ReadonlySet<number>): DiffFileTreeRow[] {
  const rows: DiffFileTreeRow[] = [];
  const visit = (id: number, depth: number) => {
    const node = tree.nodes[id];
    if (!node) return;
    if (node.kind === "file") {
      rows.push({ id: node.id, depth, kind: node.kind, name: node.name, fileIndex: node.fileIndex });
      return;
    }

    const chain = collapsedDiffFileTreeDirectoryChain(tree, node.id);
    const last = chain[chain.length - 1]!;
    rows.push({ id: node.id, depth, kind: node.kind, name: chain.map((item) => item.name).join("/") });
    if (!expanded || expanded.has(node.id)) last.children.forEach((child) => visit(child, depth + 1));
  };
  tree.roots.forEach((root) => visit(root, 0));
  return rows;
}

export function diffFileTreeRowPrefix(
  rows: readonly DiffFileTreeRow[],
  index: number,
  row: DiffFileTreeRow,
  expanded: ReadonlySet<number> | undefined,
): string {
  const indentation = Array.from({ length: row.depth }, (_, depth) => {
    if (depth === 0) return " ";
    return hasLaterSibling(rows, index, depth) ? "│  " : "   ";
  }).join("");
  const branch = row.depth === 0 ? " " : hasLaterSibling(rows, index, row.depth) ? "├─ " : "└─ ";
  const marker = row.kind === "directory" ? (expanded && !expanded.has(row.id) ? "▸ " : "▾ ") : "";

  return `${indentation}${branch}${marker}`;
}

export function allExpandedDiffFileTreeDirectories(tree: DiffFileTree): ReadonlySet<number> {
  return new Set(tree.nodes.filter((node) => node.kind === "directory").map((node) => node.id));
}

export function toggleDiffFileTreeDirectory(
  tree: DiffFileTree,
  expanded: ReadonlySet<number>,
  id: number,
): ReadonlySet<number> {
  if (tree.nodes[id]?.kind !== "directory") return expanded;
  const next = new Set(expanded);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function diffFileTreeParentDirectories(tree: DiffFileTree, fileIndex: number): ReadonlySet<number> {
  const fileNode = tree.nodes.find((node) => node.kind === "file" && node.fileIndex === fileIndex);
  const result = new Set<number>();
  if (!fileNode) return result;

  for (let parent = fileNode.parent; parent !== undefined; parent = tree.nodes[parent]?.parent) {
    result.add(parent);
  }
  return result;
}

export function orderedDiffFileTreeFileIndexes(rows: readonly DiffFileTreeRow[]): number[] {
  return rows.flatMap((row) => (row.fileIndex === undefined ? [] : [row.fileIndex]));
}

export function diffFileStatusSign(status: DiffFileStatus): string {
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  if (status === "renamed") return "R";
  return "M";
}

function collapsedDiffFileTreeDirectoryChain(tree: DiffFileTree, id: number): DiffFileTreeNode[] {
  const node = tree.nodes[id];
  if (!node) return [];
  const child = node.children.length === 1 ? tree.nodes[node.children[0]!] : undefined;
  if (child?.kind !== "directory") return [node];
  return [node, ...collapsedDiffFileTreeDirectoryChain(tree, child.id)];
}

function compareDiffFileTreeNodes(tree: DiffFileTree, left: number, right: number): number {
  const leftNode = tree.nodes[left];
  const rightNode = tree.nodes[right];
  if (!leftNode || !rightNode) return left - right;
  if (leftNode.kind !== rightNode.kind) return leftNode.kind === "directory" ? -1 : 1;
  if (leftNode.name < rightNode.name) return -1;
  if (leftNode.name > rightNode.name) return 1;
  return left - right;
}

function hasLaterSibling(rows: readonly DiffFileTreeRow[], index: number, depth: number): boolean {
  return rows.slice(index + 1).find((row) => row.depth <= depth)?.depth === depth;
}

function addDiffFileTreeNode(
  nodes: DiffFileTreeNode[],
  roots: number[],
  input: Omit<DiffFileTreeNode, "id" | "children">,
): number {
  const id = nodes.length;
  nodes.push({ ...input, id, children: [] });
  if (input.parent === undefined) roots.push(id);
  else nodes[input.parent]?.children.push(id);
  return id;
}
