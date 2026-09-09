// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { ChatWsEvent } from "../../src/chat.ts";
import type { Message } from "../../src/chats.ts";
import {
  applyDelta,
  applyHtml,
  finish,
  type Live,
  liveOf,
  tail,
} from "../../src/ui/chat/stream.ts";
import { loadRecording, type RecordingLine, recordings } from "./ws.ts";

type ChatLine = Extract<RecordingLine, { type: "chat" }>;
type DeltaEvent = Extract<ChatWsEvent, { kind: "delta" }>;
type Terminal = { live: Live; message: Message };
type Gap = { messageId: number; contentAt: number; have: number };
type StreamRun = {
  gaps: Gap[];
  finished: Terminal[];
  terminal: Terminal[];
  orders: Map<number, { reasoning: boolean; content: boolean; live: Live }>;
};

function assertCovered(v: Live) {
  expect(v.htmlAt).toBeGreaterThanOrEqual(0);
  expect(v.htmlAt).toBeLessThanOrEqual(v.content.length);
  expect(tail(v)).toBe(v.content.slice(v.htmlAt));
  expect(v.content.slice(0, v.htmlAt).length).toBe(v.htmlAt);
}

function assertFinished(v: Live, message: Message) {
  expect(v.content).toBe(message.content);
  expect(v.reasoning).toBe(message.reasoning);
  expect(v.html).toBe(message.html ?? "");
  expect(v.htmlAt).toBe(message.content.length);
  expect(v.thinkMs).toBe(message.thinkingMs);
  assertCovered(v);
}

function runStream(lines: RecordingLine[]): StreamRun {
  let live = new Map<number, Live>();
  let pending: ChatLine[] | null = null;
  const gaps: Gap[] = [];
  const finished: Terminal[] = [];
  const terminal: Terminal[] = [];
  const orders = new Map<
    number,
    { reasoning: boolean; content: boolean; live: Live }
  >();

  const note = (id: number, v: Live, event?: DeltaEvent) => {
    const seen = orders.get(id) ?? {
      reasoning: false,
      content: false,
      live: v,
    };
    if (event?.reasoning) seen.reasoning = true;
    if (event?.content) seen.content = true;
    seen.live = v;
    orders.set(id, seen);
    assertCovered(v);
  };

  const apply = (line: ChatLine) => {
    const event = line.data;
    switch (event.kind) {
      case "started": {
        const v = liveOf(event.message);
        live.set(event.message.id, v);
        note(event.message.id, v);
        break;
      }
      case "row": {
        const message = event.message;
        if (message.role !== "assistant") break;
        if (message.status === "streaming") {
          if (!live.has(message.id)) live.set(message.id, liveOf(message));
          note(message.id, live.get(message.id)!);
        } else {
          const v = finish(live.get(message.id), message, line.t);
          live.delete(message.id);
          assertFinished(v, message);
          finished.push({ live: v, message });
        }
        break;
      }
      case "delta": {
        const before = live.get(event.messageId);
        if (!before) break;
        const result = applyDelta(before, event, line.t);
        if (result.gap) expect(result.live).toEqual(before);
        live.set(event.messageId, result.live);
        if (result.gap) {
          gaps.push({
            messageId: event.messageId,
            contentAt: event.contentAt,
            have: before.content.length,
          });
        }
        note(event.messageId, result.live, event);
        break;
      }
      case "html": {
        const before = live.get(event.messageId);
        if (!before) break;
        const after = applyHtml(before, event);
        live.set(event.messageId, after);
        note(event.messageId, after);
        break;
      }
      case "done": {
        const v = finish(live.get(event.message.id), event.message, line.t);
        live.delete(event.message.id);
        assertFinished(v, event.message);
        finished.push({ live: v, message: event.message });
        terminal.push({ live: v, message: event.message });
        break;
      }
      case "chat":
      case "deleted":
        break;
    }
  };

  for (const line of lines) {
    if ("reconnect" in line || "closed" in line) {
      // a reload starts over: the record comes from the fetched row, so
      // a row resumed with content has no thinking clock
      live = new Map();
      orders.clear();
      pending = null;
      continue;
    }
    if ("type" in line && line.type === "snapshot") {
      pending = line.chat ? [] : null;
      continue;
    }
    if ("fetch" in line) {
      live = new Map(
        line.fetch.body.messages
          .filter((message) => message.status === "streaming")
          .map((message) => [message.id, liveOf(message)]),
      );
      for (const v of live.values()) assertCovered(v);
      const final = line.fetch.body.messages.at(-1);
      if (final?.role === "assistant" && final.status !== "streaming") {
        const v = liveOf(final);
        assertFinished(v, final);
        finished.push({ live: v, message: final });
        terminal.push({ live: v, message: final });
      }
      const queued = pending ?? [];
      pending = null;
      for (const event of queued) apply(event);
      continue;
    }
    if ("type" in line && line.type === "chat") {
      if (pending) pending.push(line);
      else apply(line);
    }
  }

  return { gaps, finished, terminal, orders };
}

describe("chat stream recordings", () => {
  test.each([...recordings])(
    "%s follows offsets and its terminal row",
    async (name) => {
      const run = runStream(await loadRecording(name));
      expect(run.terminal.length).toBeGreaterThan(0);
      // the row fetched after the reconnect lags the runner's buffer by
      // one write window (250 ms or 2 KB), so the first delta after the
      // fetch is ahead of it: the page reloads the chat on that gap. The
      // recording holds no second fetch, so every later delta of that row
      // is a gap too and the record stays where the fetch left it
      if (name === "reconnect.ndjson") {
        expect(run.gaps[0]).toEqual({
          messageId: run.gaps[0].messageId,
          contentAt: 1436,
          have: 1431,
        });
      } else expect(run.gaps).toEqual([]);

      for (const seen of run.orders.values()) {
        if (!seen.reasoning || !seen.content) continue;
        expect(seen.live.thinkStart).not.toBeNull();
        expect(seen.live.thinkEnd).not.toBeNull();
        expect(seen.live.thinkStart!).toBeLessThanOrEqual(seen.live.thinkEnd!);
      }
    },
  );

  test("a missing plain content delta reports a gap without changing state", async () => {
    const lines = await loadRecording("plain.ndjson");
    const deltas = lines.filter(
      (line): line is ChatLine & { data: DeltaEvent } =>
        "type" in line &&
        line.type === "chat" &&
        line.data.kind === "delta" &&
        Boolean(line.data.content),
    );
    const removed = deltas[Math.floor(deltas.length / 2)];
    let v: Live | null = null;
    let found = false;

    for (const line of lines) {
      if (!("type" in line) || line.type !== "chat") continue;
      if (line.data.kind === "started") v = liveOf(line.data.message);
      if (line === removed) continue;
      if (line.data.kind !== "delta" || !v) continue;
      const before = v;
      const result = applyDelta(v, line.data, line.t);
      v = result.live;
      if (!result.gap) continue;
      expect(v).toEqual(before);
      found = true;
      break;
    }

    expect(found).toBe(true);
  });

  test("html frames cannot move backward or ahead of content", async () => {
    const lines = await loadRecording("plain.ndjson");
    const done = lines.find(
      (
        line,
      ): line is ChatLine & {
        data: Extract<ChatWsEvent, { kind: "done" }>;
      } => "type" in line && line.type === "chat" && line.data.kind === "done",
    );
    expect(done).toBeDefined();
    const base = {
      ...liveOf(done!.data.message),
      html: "current",
      htmlAt: 10,
    };
    const old = applyHtml(base, {
      kind: "html",
      chatId: done!.data.chat.id,
      messageId: done!.data.message.id,
      html: "old",
      htmlAt: 9,
    });
    const ahead = applyHtml(base, {
      kind: "html",
      chatId: done!.data.chat.id,
      messageId: done!.data.message.id,
      html: "ahead",
      htmlAt: base.content.length + 1,
    });
    expect(old).toEqual(base);
    expect(ahead).toEqual(base);
  });

  test("stopping during thinking closes the clock at the done", async () => {
    const run = runStream(await loadRecording("think-stop.ndjson"));
    const final = run.finished.find(
      (row) => row.message.reasoning !== "" && row.live.thinkStart !== null,
    );
    expect(final).toBeDefined();
    expect(final!.message.reasoning).not.toBe("");
    expect(final!.message.content).toBe("");
    expect(final!.live.thinkStart).not.toBeNull();
    expect(final!.live.thinkEnd).not.toBeNull();
    expect(final!.live.thinkEnd!).toBeGreaterThan(final!.live.thinkStart!);
  });
});
