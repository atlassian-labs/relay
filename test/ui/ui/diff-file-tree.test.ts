import { describe, expect, test } from "bun:test";
import type { DiffFile, DiffFileStatus } from "../../../src/core/diff-utils";
import {
  allExpandedDiffFileTreeDirectories,
  buildDiffFileTree,
  diffFileTreeParentDirectories,
  diffFileTreeRowPrefix,
  flattenDiffFileTree,
  toggleDiffFileTreeDirectory,
} from "../../../src/ui/component/diff-file-tree";

function diffFile(path: string, status: DiffFileStatus = "modified"): DiffFile {
  return { path, patch: "", additions: 0, deletions: 0, status };
}

describe("diff file tree", () => {
  test("sorts directory rows before files and collapses unary directory chains", () => {
    const rows = flattenDiffFileTree(
      buildDiffFileTree([
        diffFile("README.md"),
        diffFile("packages/relay/src/app.ts"),
        diffFile("packages/relay/test/app.test.ts"),
      ]),
    );

    expect(rows.map((row) => `${"  ".repeat(row.depth)}${row.kind}:${row.name}`)).toEqual([
      "directory:packages/relay",
      "  directory:src",
      "    file:app.ts",
      "  directory:test",
      "    file:app.test.ts",
      "file:README.md",
    ]);
  });

  test("flattens only expanded directory descendants", () => {
    const tree = buildDiffFileTree([diffFile("src/core/a.ts"), diffFile("src/ui/b.ts"), diffFile("README.md")]);
    const src = tree.nodes.find((node) => node.kind === "directory" && node.name === "src");
    const core = tree.nodes.find((node) => node.kind === "directory" && node.name === "core");
    if (!src || !core) throw new Error("expected fixture directories");

    expect(flattenDiffFileTree(tree, new Set()).map((row) => row.name)).toEqual(["src", "README.md"]);
    expect(flattenDiffFileTree(tree, new Set([src.id])).map((row) => row.name)).toEqual([
      "src",
      "core",
      "ui",
      "README.md",
    ]);
    expect(flattenDiffFileTree(tree, new Set([src.id, core.id])).map((row) => row.name)).toEqual([
      "src",
      "core",
      "a.ts",
      "ui",
      "README.md",
    ]);
  });

  test("renders top-level rows flush without tree connectors", () => {
    const rows = flattenDiffFileTree(buildDiffFileTree([diffFile("AGENTS.md"), diffFile("README.md")]));

    expect(rows.map((row, index) => diffFileTreeRowPrefix(rows, index, row, undefined))).toEqual([" ", " "]);
  });

  test("draws connectors for nested rows but keeps roots flush", () => {
    const tree = buildDiffFileTree([diffFile("src/a.ts"), diffFile("src/b.ts"), diffFile("README.md")]);
    const expanded = allExpandedDiffFileTreeDirectories(tree);
    const rows = flattenDiffFileTree(tree, expanded);

    expect(rows.map((row, index) => `${diffFileTreeRowPrefix(rows, index, row, expanded)}${row.name}`)).toEqual([
      " ▾ src",
      " ├─ a.ts",
      " └─ b.ts",
      " README.md",
    ]);
  });

  test("toggles directories and finds parent directories for a file", () => {
    const tree = buildDiffFileTree([diffFile("src/core/a.ts"), diffFile("README.md")]);
    const src = tree.nodes.find((node) => node.kind === "directory" && node.name === "src");
    const core = tree.nodes.find((node) => node.kind === "directory" && node.name === "core");
    if (!src || !core) throw new Error("expected fixture directories");

    const expanded = allExpandedDiffFileTreeDirectories(tree);
    const collapsed = toggleDiffFileTreeDirectory(tree, expanded, src.id);

    expect(collapsed.has(src.id)).toBe(false);
    expect(flattenDiffFileTree(tree, collapsed).map((row) => row.name)).toEqual(["src/core", "README.md"]);
    expect([...diffFileTreeParentDirectories(tree, 0)].sort((left, right) => left - right)).toEqual([src.id, core.id]);
  });
});
