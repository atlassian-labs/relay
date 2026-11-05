import { describe, expect, test } from "bun:test";

interface Match {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Scans TypeScript source files for every occurrence of a mutation pattern.
 *
 * @param pattern - Regular expression describing the source pattern to locate.
 * @returns Sorted source locations and matching line text for every occurrence.
 */
async function sourceMatches(pattern: RegExp): Promise<Match[]> {
  const matches: Match[] = [];
  const glob = new Bun.Glob("src/**/*.{ts,tsx}");
  for await (const path of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
    const text = await Bun.file(path).text();
    const expression = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(expression)) {
      const index = match.index ?? 0;
      const line = text.slice(0, index).split("\n").length;
      const lineText = text.split("\n")[line - 1]?.trim() ?? "";
      matches.push({ path, line, text: lineText });
    }
  }
  return matches.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

describe("transcript block mutation source audit", () => {
  test("routes active structural block writes through the app-state adapter", async () => {
    const matches = await sourceMatches(/setState\s*\(\s*["']blocks["']/);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((match) => match.path === "src/ui/context/app-state.tsx")).toBe(true);
  });

  test("keeps inactive transcript writes in the thread controller mutation boundary", async () => {
    const matches = await sourceMatches(/threadBlocks\.set\s*\(/);

    expect(matches).toEqual([
      expect.objectContaining({
        path: "src/ui/app/thread-controller.ts",
        text: "store.threadBlocks.set(threadId, blocks);",
      }),
      expect.objectContaining({
        path: "src/ui/app/thread-controller.ts",
        text: "store.threadBlocks.set(app.state.activeThreadId, blocks);",
      }),
    ]);
  });

  test("does not mutate canonical TUI block arrays by assignment", async () => {
    const matches = (await sourceMatches(/\.blocks\s*=/)).filter(
      (match) => match.path.startsWith("src/ui/") && match.path !== "src/ui/context/app-state.tsx",
    );
    expect(matches).toEqual([]);
  });
});
