// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { Message } from "../../src/chats.ts";
import {
  freshSend,
  type LiveSample,
  liveStats,
} from "../../src/ui/chat/stats.ts";

const t0 = new Date(2026, 8, 9, 10, 0, 0).getTime();
const row = (id: number, role: Message["role"], over: Partial<Message> = {}) =>
  ({
    id,
    chatId: "c",
    role,
    content: "",
    html: null,
    reasoning: "",
    status: "done",
    error: null,
    finishReason: null,
    model: null,
    createdAt: t0,
    finishedAt: null,
    ttftMs: null,
    thinkingMs: null,
    stats: null,
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    ...over,
  }) as Message;
const stats = (generated: number): Message["stats"] => ({
  promptTokens: 100,
  cachedTokens: 0,
  generated,
  prefillMs: 100,
  decodeMs: 1000,
  tokenizeMs: null,
});
const idle: LiveSample = {
  requestsRunning: 0,
  requestsPrefilling: 0,
  prefillTps: null,
  decodeTps: null,
  inflightTokens: 0,
};
const decoding: LiveSample = {
  ...idle,
  requestsRunning: 1,
  decodeTps: 88.4,
  inflightTokens: 40,
};
const values = (items: { label: string; value: string }[]) =>
  items.map((i) => `${i.label} ${i.value}`.trim());

describe("live stats", () => {
  test("two requests on the engine are nobody's numbers", () => {
    const rows = [row(1, "user"), row(2, "assistant", { status: "streaming" })];
    const first = liveStats(freshSend(), rows, decoding, t0 + 1000);
    expect(values(first.items)).toEqual(["decode 88 tok/s", "40 tok", "1.0 s"]);
    // another client's request overlaps: the line keeps what it knew
    const shared = liveStats(
      first.memory,
      rows,
      { ...decoding, requestsRunning: 2, decodeTps: 150, inflightTokens: 900 },
      t0 + 2000,
    );
    expect(values(shared.items)).toEqual([
      "decode 88 tok/s",
      "40 tok",
      "2.0 s",
    ]);
    expect(shared.memory).toEqual(first.memory);
  });

  test("only the timer before the engine reports anything", () => {
    const msgs = [row(1, "user"), row(2, "assistant", { status: "streaming" })];
    const r = liveStats(freshSend(), msgs, null, t0 + 1500);
    expect(values(r.items)).toEqual(["1.5 s"]);
  });

  test("the rate and the count stay through a tool round", () => {
    const msgs = [row(1, "user"), row(2, "assistant", { status: "streaming" })];
    let r = liveStats(freshSend(), msgs, decoding, t0 + 2000);
    expect(values(r.items)).toEqual(["decode 88 tok/s", "40 tok", "2.0 s"]);
    // the round finished with 60 tokens and its call runs: no request
    const between = [
      row(1, "user"),
      row(2, "assistant", { stats: stats(60), toolCalls: [] }),
      row(3, "tool", { status: "running" }),
    ];
    r = liveStats(r.memory, between, idle, t0 + 4000);
    expect(values(r.items)).toEqual(["decode 88 tok/s", "60 tok", "4.0 s"]);
    // the next round streams: finished tokens plus the new request's
    const next = [...between, row(4, "assistant", { status: "streaming" })];
    r = liveStats(
      r.memory,
      next,
      { ...decoding, decodeTps: 90, inflightTokens: 5 },
      t0 + 5000,
    );
    expect(values(r.items)).toEqual(["decode 90 tok/s", "65 tok", "5.0 s"]);
  });

  test("the count never drops within a send", () => {
    const msgs = [row(1, "user"), row(2, "assistant", { status: "streaming" })];
    let r = liveStats(freshSend(), msgs, decoding, t0 + 2000);
    // the live count reset with a new request before the row's stats landed
    r = liveStats(
      r.memory,
      msgs,
      { ...decoding, inflightTokens: 3 },
      t0 + 2500,
    );
    expect(values(r.items)[1]).toBe("40 tok");
  });

  test("a summary streaming on its own is its own send", () => {
    const msgs = [
      row(1, "user"),
      row(2, "assistant", { stats: stats(25), createdAt: t0 - 100_000 }),
      row(3, "summary", { status: "streaming", createdAt: t0 }),
    ];
    const r = liveStats(freshSend(), msgs, decoding, t0 + 1500);
    expect(values(r.items)).toEqual(["decode 88 tok/s", "40 tok", "1.5 s"]);
  });

  test("prefill wins over decode while prefilling", () => {
    const msgs = [row(1, "user"), row(2, "assistant", { status: "streaming" })];
    const smp = { ...decoding, requestsPrefilling: 1, prefillTps: 1200.6 };
    expect(values(liveStats(freshSend(), msgs, smp, t0 + 1000).items)[0]).toBe(
      "prefill 1,201 tok/s",
    );
  });
});
