// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Markdown for chat replies, rendered on the server with Bun's built-in
// parser so the page ships no parser and receives HTML. The output is put
// into the page with innerHTML, and the input is whatever a model wrote, so
// this module is the safety boundary: Bun.markdown.render() passes the
// text of code spans and blocks through the text callback too (measured on
// Bun 1.4.2), so escaping happens in text alone and never twice; raw HTML
// is parsed as text through noHtmlBlocks and noHtmlSpans; link targets are
// kept only for http, https and mailto; images never become an img (a
// reply must not make the browser fetch a URL). The API is marked unstable
// by Bun, which is why every callback lives here and nowhere else.
// Fenced blocks are highlighted here too (src/highlight.ts): the block's
// text arrives escaped, so it is unescaped for the grammar, which escapes
// every token again on its way out. A mermaid block becomes a diagram
// (src/diagram.ts) when the caller asks for it: the reads and the finish
// do, the render every 250 ms of a streaming reply does not, since a
// layout costs far more than a grammar and a half-written diagram is
// noise; the source stays in the card, hidden, for the Copy button.

import { renderDiagram } from "./diagram.ts";
import { highlight } from "./highlight.ts";

const OPTIONS = { noHtmlBlocks: true, noHtmlSpans: true } as const;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The exact inverse of escapeHtml, in the reverse order so an "&amp;lt;"
// comes back as the "&lt;" the model wrote.
function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

const SAFE_HREF = /^(https?:|mailto:)/i;
const COPY_BLOCK =
  '<button type="button" class="ibtn copy" title="Copy" aria-label="Copy block"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g class="copy-icon" fill="none"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></g><path class="copied-icon" fill="none" d="m5 12 4 4L19 6"/></svg></button>';
const EXPAND_DIAGRAM =
  '<button type="button" class="ibtn expand" title="Full screen" aria-label="Expand diagram" aria-haspopup="dialog"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path fill="none" d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg></button>';

// The info string is free text ("ts", "python title=x"); only its first
// word is a language, and only a plain token is worth a data attribute.
function language(info: string | undefined): string {
  const word = (info ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[\w+#.-]{1,24}$/.test(word) ? word.toLowerCase() : "";
}

// A fenced block becomes a card with a head (language label, copy button)
// so the page can wire the copy without knowing the markup; the text to
// copy is the pre's textContent, which the highlight spans leave as is.
function codeBlock(
  text: string,
  info: string | undefined,
  diagrams: boolean,
): string {
  const lang = language(info);
  const label = lang ? `<span class="lang">${escapeHtml(lang)}</span>` : "";
  const head = `<div class="ch">${label}${COPY_BLOCK}</div>`;
  if (lang === "mermaid" && diagrams) {
    const img = renderDiagram(unescapeHtml(text));
    if (img !== null) {
      return `<div class="code" data-lang="mermaid"><div class="ch">${label}${COPY_BLOCK}${EXPAND_DIAGRAM}</div>${img}<pre hidden><code>${text}</code></pre></div>`;
    }
  }
  const body = (lang && highlight(unescapeHtml(text), lang)) || text;
  return (
    `<div class="code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}>` +
    `${head}<pre><code>${body}</code></pre></div>`
  );
}

const align = (a: string | undefined) => (a ? ` style="text-align:${a}"` : "");

const callbacks = (diagrams: boolean) => ({
  text: (c: string) => escapeHtml(c),
  html: (c: string) => escapeHtml(c),
  paragraph: (c: string) => `<p>${c}</p>`,
  heading: (c: string, m: { level: number }) =>
    `<h${m.level}>${c}</h${m.level}>`,
  blockquote: (c: string) => `<blockquote>${c}</blockquote>`,
  hr: () => "<hr>",
  strong: (c: string) => `<strong>${c}</strong>`,
  emphasis: (c: string) => `<em>${c}</em>`,
  strikethrough: (c: string) => `<del>${c}</del>`,
  codespan: (c: string) => `<code>${c}</code>`,
  code: (c: string, m?: { language?: string }) =>
    codeBlock(c, m?.language, diagrams),
  link: (c: string, m: { href: string; title?: string }) => {
    if (!SAFE_HREF.test(m.href)) return c;
    const title = m.title ? ` title="${escapeHtml(m.title)}"` : "";
    return `<a href="${escapeHtml(m.href)}"${title} target="_blank" rel="noopener">${c}</a>`;
  },
  // alt text only; the src is shown so the reader can still open it by hand
  image: (c: string, m: { src: string }) =>
    `<span class="img">[image${c ? `: ${c}` : ""}${m.src ? ` ${escapeHtml(m.src)}` : ""}]</span>`,
  list: (c: string, m: { ordered: boolean; start?: number }) =>
    m.ordered
      ? `<ol${m.start !== undefined && m.start !== 1 ? ` start="${m.start}"` : ""}>${c}</ol>`
      : `<ul>${c}</ul>`,
  listItem: (c: string, m: { checked?: boolean }) =>
    m.checked === undefined
      ? `<li>${c}</li>`
      : `<li class="task"><input type="checkbox" disabled${m.checked ? " checked" : ""}> ${c}</li>`,
  // a wrapper so a wide table scrolls inside the bubble, never the page
  table: (c: string) => `<div class="tbl"><table>${c}</table></div>`,
  thead: (c: string) => `<thead>${c}</thead>`,
  tbody: (c: string) => `<tbody>${c}</tbody>`,
  tr: (c: string) => `<tr>${c}</tr>`,
  th: (c: string, m?: { align?: string }) => `<th${align(m?.align)}>${c}</th>`,
  td: (c: string, m?: { align?: string }) => `<td${align(m?.align)}>${c}</td>`,
});

const FINAL = callbacks(true);
const STREAMING = callbacks(false);

// Markdown text to safe HTML. Never throws: a parser failure falls back to
// the escaped text, so a reply is always readable. `streaming` skips the
// diagrams for the render of a reply in progress.
export function renderMarkdown(md: string, streaming = false): string {
  if (md === "") return "";
  try {
    return Bun.markdown.render(md, streaming ? STREAMING : FINAL, OPTIONS);
  } catch {
    return `<p>${escapeHtml(md)}</p>`;
  }
}
