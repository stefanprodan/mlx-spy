// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One streaming reply as this tab has it. A reply is text the server owns;
// every delta carries the buffer offset it belongs at, so a tab that opened
// mid-answer (or lost its socket) fetches the row, applies the deltas that
// continue it and drops the ones it already has. Markdown arrives as HTML
// rendered on the server: the page shows that HTML plus the text received
// after it as a plain tail, so a code block in progress never breaks out of
// its element. Pure: the caller passes the clock.

import type { ChatWsEvent } from "../../chat.ts";
import type { Message } from "../../chats.ts";

export type Live = {
  content: string;
  reasoning: string;
  // what the server last rendered, covering content[0, htmlAt)
  html: string;
  htmlAt: number;
  // client clocks for the thinking label while it streams; a finished row
  // carries the runner's measurement in thinkMs
  thinkStart: number | null;
  thinkEnd: number | null;
  thinkMs: number | null;
};

type DeltaEvent = Extract<ChatWsEvent, { kind: "delta" }>;
type HtmlEvent = Extract<ChatWsEvent, { kind: "html" }>;

export function liveOf(m: Message): Live {
  return {
    content: m.content,
    reasoning: m.reasoning,
    html: m.html ?? "",
    htmlAt: m.content.length,
    // resumed mid-answer: the clock starts at what the row says
    thinkStart:
      m.reasoning !== "" && m.content === ""
        ? m.createdAt + (m.ttftMs ?? 0)
        : null,
    thinkEnd: null,
    thinkMs: m.thinkingMs,
  };
}

// the part of a delta past what the buffer holds: all of it when it
// continues the buffer, the rest when it overlaps a fetched row, null when
// it is ahead (the socket dropped some)
function past(text: string, at: number, have: number): string | null {
  if (at > have) return null;
  return text.slice(have - at);
}

export function applyDelta(
  v: Live,
  ev: DeltaEvent,
  now: number,
): { live: Live; gap: boolean } {
  let reasoning = v.reasoning;
  let content = v.content;
  let { thinkStart, thinkEnd } = v;
  if (ev.reasoning !== undefined) {
    const add = past(ev.reasoning, ev.reasoningAt, reasoning.length);
    if (add === null) return { live: v, gap: true };
    if (add !== "" && reasoning === "") thinkStart = now;
    reasoning += add;
  }
  if (ev.content !== undefined) {
    const add = past(ev.content, ev.contentAt, content.length);
    if (add === null) return { live: v, gap: true };
    if (add !== "" && content === "" && thinkStart !== null) {
      thinkEnd ??= now;
    }
    content += add;
  }
  return {
    live: { ...v, content, reasoning, thinkStart, thinkEnd },
    gap: false,
  };
}

export function applyHtml(v: Live, ev: HtmlEvent): Live {
  // an event buffered before the fetch must not move the boundary back,
  // and a frame ahead of the text belongs to a delta not yet seen
  if (ev.htmlAt > v.content.length || ev.htmlAt < v.htmlAt) return v;
  return { ...v, html: ev.html, htmlAt: ev.htmlAt };
}

export function finish(v: Live | undefined, m: Message, now: number): Live {
  return {
    content: m.content,
    reasoning: m.reasoning,
    html: m.html ?? "",
    htmlAt: m.content.length,
    thinkStart: v?.thinkStart ?? null,
    thinkEnd: v ? (v.thinkEnd ?? now) : null,
    thinkMs: m.thinkingMs,
  };
}

export const tail = (v: Live): string => v.content.slice(v.htmlAt);
