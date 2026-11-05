export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch: string) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}

export function escapeAttribute(value: unknown): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function stripIndent(value: unknown): string {
  return String(value ?? "").replace(/^\n+|\n+$/g, "");
}

const KEYWORDS = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "defer",
  "else",
  "export",
  "for",
  "from",
  "func",
  "function",
  "go",
  "if",
  "import",
  "interface",
  "let",
  "package",
  "return",
  "select",
  "struct",
  "switch",
  "throw",
  "try",
  "type",
  "var",
  "while",
]);

function highlightCode(code: unknown, lang = ""): string {
  const escaped = escapeHtml(stripIndent(code));
  if (lang.toLowerCase().includes("json")) {
    return escaped.replace(/(&quot;[^&]*?&quot;)(\s*:)?/g, (_match: string, key: string, colon: string | undefined) =>
      colon ? `<span class="tok-key">${key}</span>${colon}` : `<span class="tok-string">${key}</span>`,
    );
  }
  return escaped.replace(
    /(&quot;.*?&quot;|'.*?'|`.*?`)|(#[^\n]*|\/\/[^\n]*)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_][\w-]*)\b/g,
    (
      match: string,
      stringToken: string | undefined,
      commentToken: string | undefined,
      numberToken: string | undefined,
      wordToken: string | undefined,
    ) => {
      if (stringToken) return `<span class="tok-string">${stringToken}</span>`;
      if (commentToken) return `<span class="tok-comment">${commentToken}</span>`;
      if (numberToken) return `<span class="tok-number">${numberToken}</span>`;
      if (wordToken && KEYWORDS.has(wordToken)) return `<span class="tok-keyword">${wordToken}</span>`;
      return match;
    },
  );
}

export function renderCodeBlock(code: unknown, lang = ""): string {
  const label = lang ? `<span>${escapeHtml(lang)}</span>` : "";
  return `<div class="code-card"><div class="code-head">${label}</div><pre><code>${highlightCode(code, lang)}</code></pre></div>`;
}

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("Index: ")) return "diff-file";
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-remove";
  return "diff-context";
}

/** Drop the synthetic `createPatch` preamble (Index:, ===, ---/+++ headers) so the
 * inline diff reads as just hunks + changed lines, matching the concise transcript. */
function isDiffNoise(line: string): boolean {
  return (
    line.startsWith("Index: ") ||
    /^=+$/.test(line) ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("\\ No newline")
  );
}

export function renderDiffBlock(diffText: unknown): string {
  const lines = stripIndent(diffText)
    .split("\n")
    .filter((line) => !isDiffNoise(line));
  const rendered = lines
    .map((line) => `<span class="diff-line ${diffLineClass(line)}">${escapeHtml(line || " ")}</span>`)
    .join("");
  return `<div class="code-card diff-card"><pre><code class="diff-code">${rendered}</code></pre></div>`;
}

export function formatToolName(name: unknown): string {
  return String(name ?? "tool")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function inlineMarkdown(value: unknown): string {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  html = html.replace(/(?<!["'=])(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
  return html;
}

export function markdown(value: unknown): string {
  const source = String(value ?? "");
  if (!source.trim()) return "";
  const parts: string[] = [];
  let last = 0;
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(source))) {
    if (match.index > last) parts.push(renderMarkdownText(source.slice(last, match.index)));
    parts.push(renderCodeBlock(match[2], match[1].trim()));
    last = fence.lastIndex;
  }
  if (last < source.length) parts.push(renderMarkdownText(source.slice(last)));
  return parts.join("");
}

function renderMarkdownText(value: unknown): string {
  const blocks = String(value)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  return blocks
    .map((block) => {
      const lines = block.split(/\n/);
      const heading = block.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        const level = Math.min(heading[1].length + 1, 4);
        return `<h${level}>${inlineMarkdown(heading[2])}</h${level}>`;
      }
      if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
        return `<ul>${lines.map((line) => `<li>${inlineMarkdown(line.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
      }
      if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
        return `<ol>${lines.map((line) => `<li>${inlineMarkdown(line.replace(/^\s*\d+\.\s+/, ""))}</li>`).join("")}</ol>`;
      }
      return `<p>${inlineMarkdown(lines.join("\n"))}</p>`;
    })
    .join("");
}

export function compactText(value: unknown, max = 240): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}
