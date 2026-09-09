// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The transcript's markup at three points of the tools recording, so the
// class names and nesting style.css folds on are asserted, not eyeballed.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { renderMarkdown } from "../../src/markdown.ts";
import { state } from "../../src/ui/chat/store.ts";
import { Row, Thread } from "../../src/ui/chat/Thread.tsx";
import { groupRows } from "../../src/ui/chat/thread.ts";
import { driveRecording, loadRecording } from "./ws.ts";

const lines = await loadRecording("tools.ndjson");
const run = driveRecording("tools.ndjson", lines);
const html = (i: number) =>
  groupRows(run.steps[i].state, run.toolsOn)
    .map((n) => render(<Row node={n} />))
    .join("");
const kind = (i: number) => {
  const l = run.steps[i].line;
  return "type" in l && l.type === "chat" ? l.data : null;
};
// the first delta of the first round, the tool row's "done" of the first
// round (between rounds), and the done
const midRound = run.steps.findIndex((_, i) => kind(i)?.kind === "delta");
const betweenRounds = run.steps.findIndex((_, i) => {
  const ev = kind(i);
  return (
    ev?.kind === "row" &&
    ev.message.role === "tool" &&
    ev.message.status === "done"
  );
});
const done = run.steps.findIndex((_, i) => kind(i)?.kind === "done");

describe("thread markup", () => {
  test("the scroll box, the thread and the jump button around the rows", () => {
    // the recordings have no fenced block: the last reply gets one through
    // the server's renderer, the markup the delegated Copy handler keys on
    const chat = run.state!.chat;
    const messages = chat.messages.map((m, i) =>
      i === chat.messages.length - 1
        ? { ...m, html: renderMarkdown("```ts\nlet a = 1;\n```") }
        : m,
    );
    state.value = { ...run.state!, chat: { ...chat, messages } };
    const h = render(<Thread />);
    state.value = null;
    expect(h).toMatch(
      /^<div class="scroll"><div class="thread"><div class="msg user"/,
    );
    expect(h).toContain(
      '</div></div><button type="button" class="jump" hidden',
    );
    // the server's code block markup the delegated Copy handler keys on
    expect(h).toContain('<div class="code" data-lang="');
    expect(h).toContain('<div class="ch">');
    expect(h).toContain(
      '<button type="button" class="copy">Copy</button></div><pre><code>',
    );
  });

  test("the draft shows the empty state instead of rows", () => {
    state.value = null;
    const h = render(<Thread />);
    expect(h).toContain('<div class="thread"></div><div class="empty">');
  });

  test("mid-round: the row streams inside a live work group", () => {
    const h = html(midRound);
    expect(h).toContain('<details class="work live">');
    expect(h).toContain('<span class="wl">Working</span>');
    expect(h).toContain('<div class="wb"><div class="msg assistant"');
    expect(h).toContain('<div class="tail"><span class="cursor"></span>');
    expect(h).not.toContain('<div class="after">');
  });

  test("between rounds: the folded round holds its call and result", () => {
    const h = html(betweenRounds);
    expect(h).toContain('<span class="wl">Working · 1 tool call</span>');
    expect(h).toContain('<div class="tools"><details class="tool" data-call=');
    expect(h).toContain('<span class="tn">websearch</span>');
    expect(h).toContain(
      '<div class="lbl">result, untrusted</div><div class="out">',
    );
    expect(h).toContain('<div class="after"><span class="acts">');
  });

  test("done: the group settles and the reply sits outside it", () => {
    const h = html(done);
    expect(h).toMatch(
      /<details class="work"><summary>.*Worked for \d+ s · 2 tool calls/,
    );
    const [group, reply] = h.split('</details><div class="msg assistant"');
    expect(group).toContain('<details class="think" data-of=');
    expect(reply).toContain('<div class="md">');
    expect(reply).toContain('<div class="tail" hidden');
    expect(reply).toContain('<button type="button">Regenerate</button>');
  });
});
