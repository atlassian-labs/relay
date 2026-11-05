import { render } from "grok-mermaid";
import { Marked, type Token } from "marked";
import type { MermaidRenderingMode } from "../../config";

export interface MermaidMarkdownContext {
  availableWidth: number;
  finalized: boolean;
  mode: MermaidRenderingMode;
}

const markdownParser = new Marked();

function isMermaidCodeBlock(token: Token): token is Token & { type: "code"; text: string; lang?: string } {
  return token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

function codeSpan(line: string): string {
  const content = line || "\u00a0";
  const longestBacktickRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestBacktickRun + 1);
  const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${padding}${content}${padding}${fence}`;
}

/** Replace top-level Mermaid code blocks with terminal-friendly Unicode diagrams. */
export function renderMermaidMarkdown(markdown: string, context: MermaidMarkdownContext): string {
  if (
    context.mode === "off" ||
    (!context.finalized && context.mode !== "streaming") ||
    context.availableWidth < 1 ||
    !/mermaid/i.test(markdown)
  ) {
    return markdown;
  }

  return markdownParser
    .lexer(markdown)
    .map((token) => {
      if (!isMermaidCodeBlock(token)) return token.raw;

      const art = render(token.text);
      if (!art || art.width > context.availableWidth) return token.raw;

      if (context.finalized && art.warnings.length > 0) {
        const suffix = art.warnings.length > 1 ? ` (+${art.warnings.length - 1} more)` : "";
        const warning = `Mermaid diagram not rendered: ${art.warnings[0]}${suffix}`;
        return `${token.raw}\n${codeSpan(warning)}  \n`;
      }

      return `${art.plain.map(codeSpan).join("  \n")}\n`;
    })
    .join("");
}
