// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Mermaid diagrams in a reply, drawn on the server by beautiful-mermaid
// (a parser and an ELK layout, no DOM) so the page ships no renderer. The
// SVG goes into the page as the data URL of an img: an image never runs a
// script, never fetches anything and its stylesheet cannot reach the
// page's own inline SVGs, so the library's escaping is not what the
// safety rests on. Its stylesheet imports Google Fonts, which is stripped
// (a reply must not make the browser fetch a URL); the font is the
// system stack instead. Layout is synchronous and superlinear (measured
// 2026-09-09: 200 edges 250 ms, 400 edges 820 ms), so a source over
// MAX_BYTES or MAX_EDGES is not drawn, a diagram is only drawn for a finished reply
// (the caller's choice, see renderMarkdown) and the last renders are
// cached for the reads that follow.

import { renderMermaidSVG } from "beautiful-mermaid";

export const MAX_BYTES = 8 * 1024;
export const MAX_EDGES = 200;
export const MAX_SVG_BYTES = 512 * 1024;

// The layout's cost is in the edges, not the bytes: a dense all-to-all
// graph of 731 edges fits in 8 KB and took 28 s (found in review,
// 2026-09-09); 240 dense edges take 0.7 s. A line is groups of nodes
// joined by arrows, "A & B --> C & D" is four edges, so each arrow
// counts the product of the group sizes on its two sides.
export function edgeCount(source: string): number {
  let n = 0;
  for (const line of source.split("\n")) {
    const groups = line.split(
      /-{2,}[>xo]?|={2,}>?|-\.+-?>?|\.{2,}>?|-->>|->>?/,
    );
    for (let i = 1; i < groups.length; i++) {
      const left = 1 + (groups[i - 1].match(/&/g)?.length ?? 0);
      const right = 1 + (groups[i].match(/&/g)?.length ?? 0);
      n += left * right;
    }
  }
  return n;
}

// the palette of style.css, literal because an image sees no CSS variable
const COLORS = {
  bg: "#0f1216",
  fg: "#e3e3e3",
  line: "#5b6470",
  accent: "#a78bfa",
  muted: "#9aa0a6",
  surface: "#1e1f20",
  border: "#2a2b2d",
};

// the library quotes the name as one family and appends system-ui itself
const FONT = "system-ui";

// the last renders, by source, within a byte budget (an XY chart can be
// a megabyte of SVG); the oldest entry goes first
const CACHE_BYTES = 8 * 1024 * 1024;
const cache = new Map<string, string | null>();
let cached = 0;

function remember(source: string, svg: string | null): string | null {
  cached += svg?.length ?? 0;
  while (cached > CACHE_BYTES && cache.size > 0) {
    const oldest = cache.keys().next().value as string;
    cached -= cache.get(oldest)?.length ?? 0;
    cache.delete(oldest);
  }
  cache.set(source, svg);
  return svg;
}

// Style directives (style, classDef, linkStyle, class) carry the model's
// CSS into attributes of the SVG as written, escapes and comments
// included, so they are dropped from the source: the palette is the
// page's anyway.
const STYLE_LINE = /^\s*(style|classDef|linkStyle|class)\s.*$/gm;

// Nothing in the image may point outward. An SVG shown as an image loads
// no external resource and runs no script by the browsers' rules, so this
// is the second line; it is cheap because the library's own output never
// carries these, and a CSS escape or comment in a value (u\72l, u/**/rl)
// fails it too.
const OUTWARD =
  /url\((?!#)|@import|<script|href|<foreignObject|<image|<use|\\|\/\*(?! Derived)/i;

// The SVG for a mermaid source, or null when the source or the SVG is too
// big or the library cannot draw it (a syntax it lacks, a parse error, an
// unfinished block).
export function renderDiagramSvg(source: string): string | null {
  if (Buffer.byteLength(source) > MAX_BYTES || edgeCount(source) > MAX_EDGES)
    return null;
  const hit = cache.get(source);
  if (hit !== undefined) return hit;
  try {
    const svg = renderMermaidSVG(source.replace(STYLE_LINE, ""), {
      ...COLORS,
      font: FONT,
      transparent: true,
    }).replace(/^\s*@import url\([^)]*\);?\s*$/gm, "");
    const ok = svg.length <= MAX_SVG_BYTES && !OUTWARD.test(svg);
    return remember(source, ok ? svg : null);
  } catch {
    return remember(source, null);
  }
}

// The img markup for the page, or null.
export function renderDiagram(source: string): string | null {
  const svg = renderDiagramSvg(source);
  if (svg === null) return null;
  const data = Buffer.from(svg, "utf8").toString("base64");
  return `<img class="diagram" alt="diagram" src="data:image/svg+xml;base64,${data}">`;
}
