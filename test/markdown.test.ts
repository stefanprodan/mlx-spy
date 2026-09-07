import { describe, expect, test } from "bun:test";
import { escapeHtml, renderMarkdown } from "../src/markdown.ts";

describe("renderMarkdown", () => {
  test("empty input renders nothing", () => {
    expect(renderMarkdown("")).toBe("");
  });

  test("basic blocks and inlines", () => {
    const html = renderMarkdown(
      "# Title\n\nSome **bold**, *em*, ~~gone~~ and `code`.\n\n> quote\n\n---\n",
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<blockquote><p>quote</p></blockquote>");
    expect(html).toContain("<hr>");
  });

  test("raw HTML in text is escaped, never passed through", () => {
    const html = renderMarkdown(
      'Hi <b>x</b> & "q"\n\n<script>alert(1)</script>\n\n<div>\nblock\n</div>',
    );
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<div>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt; &amp; &quot;q&quot;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("code spans and blocks are escaped once", () => {
    const html = renderMarkdown('`a<b&c`\n\n```ts\nconst x = "<y>&";\n```');
    expect(html).toContain("<code>a&lt;b&amp;c</code>");
    expect(html).toContain(
      "<pre><code>const x = &quot;&lt;y&gt;&amp;&quot;;\n</code></pre>",
    );
    expect(html).not.toContain("&amp;lt;");
  });

  test("fenced block carries the language and a copy button", () => {
    const html = renderMarkdown("```python title=x\nprint(1)\n```");
    expect(html).toContain('<div class="code" data-lang="python">');
    expect(html).toContain('<span class="lang">python</span>');
    expect(html).toContain('<button type="button" class="copy">Copy</button>');
    const plain = renderMarkdown("```\nx\n```");
    expect(plain).toContain('<div class="code"><div class="ch"><button');
    expect(plain).not.toContain("data-lang");
  });

  test("links keep only http, https and mailto", () => {
    const html = renderMarkdown(
      '[ok](https://example.com "ti<tle") [mail](mailto:a@b.c) [bad](javascript:alert(1)) [data](data:text/html,x)',
    );
    expect(html).toContain(
      '<a href="https://example.com" title="ti&lt;tle" target="_blank" rel="noopener">ok</a>',
    );
    expect(html).toContain('<a href="mailto:a@b.c"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:");
    expect(html).toContain(" bad data</p>");
  });

  test("images never become img elements", () => {
    const html = renderMarkdown("![logo](http://x/y.png) ![](http://x/z.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain(
      '<span class="img">[image: logo http://x/y.png]</span>',
    );
    expect(html).toContain('<span class="img">[image http://x/z.png]</span>');
  });

  test("lists, ordered starts and task items", () => {
    const html = renderMarkdown(
      "3. three\n4. four\n\n- [x] done\n- [ ] todo\n- plain",
    );
    expect(html).toContain('<ol start="3"><li>three</li><li>four</li></ol>');
    expect(html).toContain(
      '<li class="task"><input type="checkbox" disabled checked> done</li>',
    );
    expect(html).toContain(
      '<li class="task"><input type="checkbox" disabled> todo</li>',
    );
    expect(html).toContain("<li>plain</li>");
    expect(renderMarkdown("1. a\n2. b")).toContain("<ol><li>a</li>");
  });

  test("tables are wrapped and aligned", () => {
    const html = renderMarkdown("| a | b |\n|:--|--:|\n| 1 | 2 |");
    expect(html).toContain(
      '<div class="tbl"><table><thead><tr><th style="text-align:left">a</th>',
    );
    expect(html).toContain('<td style="text-align:right">2</td>');
    expect(html).toContain("</tbody></table></div>");
  });

  test("a partial reply mid-stream still renders", () => {
    const html = renderMarkdown("Some **unclosed\n\n```ts\nconst x =");
    expect(html).toContain("<p>Some **unclosed</p>");
    expect(html).toContain("<code>const x =");
  });

  test("escapeHtml covers the four characters", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;",
    );
  });
});
