// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The numbers line in the composer: the last reply's engine timings, or
// the live rate the monitor sees while a reply streams here. The line
// covers the whole send: tokens from every round, time from the first.
// Pure, tested in test/ui/stats.test.ts.

import type { Message } from "../../chats.ts";
import { secs, tps } from "../format.ts";
import { n, sendRows } from "./store.ts";

export type Item = { label: string; value: string; cls?: string };

export type LiveSample = {
  requestsRunning: number;
  requestsPrefilling: number;
  prefillTps: number | null;
  decodeTps: number | null;
  inflightTokens: number;
};

// What the line last knew during a send. The engine has no request
// running between rounds (a tool call) or before a load finishes, so the
// rate and the count would vanish and come back; they stay put instead
// and move on when the next round streams.
export type SendMemory = { rate: Item | null; tokens: number };
export const freshSend = (): SendMemory => ({ rate: null, tokens: 0 });

const rateOf = (smp: LiveSample): Item | null => {
  if (smp.requestsRunning === 0) return null;
  if (smp.requestsPrefilling > 0 && smp.prefillTps) {
    return {
      label: "prefill",
      value: `${n(Math.round(smp.prefillTps))} tok/s`,
    };
  }
  if (smp.decodeTps) {
    return { label: "decode", value: `${n(Math.round(smp.decodeTps))} tok/s` };
  }
  return null;
};

// the send's rows: the assistant rows after the last user row
function currentSend(messages: Message[]): Message[] {
  const lastUser = messages.filter((m) => m.role === "user").at(-1);
  return messages.filter(
    (m) => m.id > (lastUser?.id ?? 0) && m.role === "assistant",
  );
}

export function liveStats(
  memory: SendMemory,
  messages: Message[],
  smp: LiveSample | null,
  now: number,
): { items: Item[]; memory: SendMemory } {
  const rows = currentSend(messages);
  // the finished rounds' tokens plus the running request's, never less
  // than what was shown: the count only grows within a send
  const finished = rows.reduce((sum, x) => sum + (x.stats?.generated ?? 0), 0);
  const inflight = smp && smp.requestsRunning > 0 ? smp.inflightTokens : 0;
  const tokens = Math.max(memory.tokens, finished + inflight);
  const rate = (smp && rateOf(smp)) ?? memory.rate;
  const items: Item[] = [];
  if (rate) items.push(rate);
  if (tokens > 0) items.push({ label: "", value: `${n(tokens)} tok` });
  const first = rows[0];
  if (first) {
    items.push({ label: "", value: secs(now - first.createdAt), cls: "x" });
  }
  return { items, memory: { rate, tokens } };
}

// the last reply's numbers; a stopped or failed one has none and the
// line hides rather than show an older reply's
export function doneStats(messages: Message[]): Item[] | null {
  const items: Item[] = [];
  const last = messages.filter((m) => m.role === "assistant").at(-1);
  const st = last?.stats;
  if (!last || !st) return null;
  const rounds = sendRows(messages, last).filter((x) => x.role === "assistant");
  const first = rounds[0] ?? last;
  const generated = rounds.reduce(
    (sum, x) => sum + (x.stats?.generated ?? 0),
    0,
  );
  if (typeof st.prefillMs === "number") {
    items.push({
      label: "prefill",
      value: tps(st.promptTokens - st.cachedTokens, st.prefillMs),
    });
  }
  if (typeof st.decodeMs === "number") {
    items.push({ label: "decode", value: tps(st.generated, st.decodeMs) });
  }
  if (st.promptTokens > 0) {
    items.push({
      label: "cache",
      value: `${Math.round((st.cachedTokens / st.promptTokens) * 100)}%`,
    });
  }
  items.push({
    label: "",
    value: `${n(Math.max(generated, st.generated))} tok`,
    cls: "x",
  });
  if (last.finishedAt !== null) {
    items.push({
      label: "",
      value: secs(last.finishedAt - first.createdAt),
      cls: "x",
    });
  }
  return items;
}
