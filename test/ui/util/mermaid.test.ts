import { describe, expect, test } from "bun:test";
import { renderMermaidMarkdown } from "../../../src/ui/util/mermaid";

interface RenderOptions {
  availableWidth?: number;
  finalized?: boolean;
  mode?: "off" | "final" | "streaming";
}

function renderMarkdown(markdown: string, options: RenderOptions = {}): string {
  return renderMermaidMarkdown(markdown, {
    availableWidth: options.availableWidth ?? 100,
    finalized: options.finalized ?? true,
    mode: options.mode ?? "streaming",
  });
}

describe("Mermaid Markdown rendering", () => {
  test("replaces top-level Mermaid code blocks with Unicode diagrams", () => {
    const markdown = "Before\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\nAfter";
    const rendered = renderMarkdown(markdown);

    expect(rendered).toContain("Before");
    expect(rendered).toContain("┌───────┐");
    expect(rendered).toContain("│ Start ├───▶│ Done │");
    expect(rendered).not.toContain("```mermaid");
    expect(rendered).toContain("After");
  });

  test("leaves unsupported and oversized diagrams unchanged", () => {
    const unsupported = '```mermaid\npie\n  title Pets\n  "Dogs" : 4\n```';
    const oversized = "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```";

    expect(renderMarkdown(unsupported)).toBe(unsupported);
    expect(renderMarkdown(oversized, { availableWidth: 10 })).toBe(oversized);
  });

  test("renders incomplete blocks only in streaming mode", () => {
    const markdown = "```mermaid\nflowchart LR\n  A --> B";

    expect(renderMarkdown(markdown, { finalized: false, mode: "streaming" })).toContain("───▶");
    expect(renderMarkdown(markdown, { finalized: false, mode: "final" })).toBe(markdown);
    expect(renderMarkdown(markdown, { finalized: true, mode: "final" })).not.toContain("```mermaid");
  });

  test("falls back to source with a warning when finalized parsing is partial", () => {
    const markdown = "```mermaid\nflowchart LR\n  A[Foo]:::highlight --> B[Bar]\n```";
    const finalized = renderMarkdown(markdown);
    const streaming = renderMarkdown(markdown, { finalized: false });

    expect(finalized).toContain(markdown);
    expect(finalized).toContain("Mermaid diagram not rendered:");
    expect(streaming).not.toContain("```mermaid");
    expect(streaming).toContain("│ Foo │");
  });

  test("respects off mode and preserves nested Mermaid fences", () => {
    const markdown = "```mermaid\nflowchart LR\n  A --> B\n```";
    const nested = `> ${markdown.replaceAll("\n", "\n> ")}`;

    expect(renderMarkdown(markdown, { mode: "off" })).toBe(markdown);
    expect(renderMarkdown(nested)).toBe(nested);
  });
});
