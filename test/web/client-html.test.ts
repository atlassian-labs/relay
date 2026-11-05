import { describe, expect, test } from "bun:test";
import {
  compactText,
  escapeAttribute,
  escapeHtml,
  markdown,
  renderCodeBlock,
  renderDiffBlock,
} from "../../src/web/client/html";

describe("web client html helpers", () => {
  test("escapes text and attributes", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(escapeAttribute('hello "relay"')).toBe("hello &quot;relay&quot;");
  });

  test("renders markdown without leaking raw html", () => {
    const html = markdown("# Title\n\n<script>alert(1)</script>\n\n- `item`");
    expect(html).toContain("<h2>Title</h2>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('<li><code class="inline-code">item</code></li>');
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("renders fenced code blocks with language labels", () => {
    const html = markdown("```ts\nconst answer = 42;\n```");
    expect(html).toContain('class="code-card"');
    expect(html).toContain("<span>ts</span>");
    expect(html).toContain("const");
  });

  test("renders unified diffs with line classes", () => {
    const html = renderDiffBlock("--- before\n+++ after\n@@ -1 +1 @@\n-old\n+new");
    expect(html).toContain('class="code-card diff-card"');
    expect(html).toContain('class="diff-line diff-remove"');
    expect(html).toContain('class="diff-line diff-add"');
    expect(html).toContain("+new");
  });

  test("renders standalone code blocks and compacts long text", () => {
    expect(renderCodeBlock("export default 1", "ts")).toContain("export");
    expect(compactText("a".repeat(300), 12)).toBe("aaaaaaaaaaaa…");
  });
});
