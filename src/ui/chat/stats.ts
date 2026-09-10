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

// a reply's cost: four decimals under a cent, else two
export const usd = (v: number) =>
  v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;

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

// The engine's gauges describe its one request at a time; with two in
// flight (another client's next to this chat's) neither the rate nor the
// live count is this send's, so the line keeps what it last knew
// instead, as it does between rounds. Best-effort: the engine reports no
// request ids, so one request is assumed to be this one.
const own = (smp: LiveSample | null): LiveSample | null =>
  smp && smp.requestsRunning === 1 ? smp : null;

const rateOf = (smp: LiveSample): Item | null => {
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

// the send's rows: the assistant rows after the last user row, or the
// summary row alone while one streams (a /compact has no user row, and
// the numbers of the reply before it are not this send's)
function currentSend(messages: Message[]): Message[] {
  const last = messages.at(-1);
  if (last?.role === "summary" && last.status === "streaming") return [last];
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
  const mine = own(smp);
  // the finished rounds' tokens plus the running request's, never less
  // than what was shown: the count only grows within a send
  const finished = rows.reduce((sum, x) => sum + (x.stats?.generated ?? 0), 0);
  const inflight = mine ? mine.inflightTokens : 0;
  const tokens = Math.max(memory.tokens, finished + inflight);
  const rate = (mine && rateOf(mine)) ?? memory.rate;
  const items: Item[] = [];
  if (rate) items.push(rate);
  if (tokens > 0) items.push({ label: "", value: `${n(tokens)} tok` });
  const first = rows[0];
  if (first) {
    items.push({ label: "", value: secs(now - first.createdAt), cls: "x" });
  }
  return { items, memory: { rate, tokens } };
}

// Hide missing usage rather than show an older reply's. A failure in
// tools retains the completed engine round's usage.
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
  // a hosted reply's zero is the upstream not caching at all, not a miss
  if (st.promptTokens > 0 && !(st.cost !== null && st.cachedTokens === 0)) {
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
  // a hosted reply's cost, summed over the send's rounds; a free model
  // says so rather than showing nothing
  if (st.cost !== null) {
    const cost = rounds.reduce((sum, x) => sum + (x.stats?.cost ?? 0), 0);
    items.push({ label: "", value: cost === 0 ? "free" : usd(cost) });
  }
  if (last.finishedAt !== null) {
    items.push({
      label: "",
      value: secs(last.finishedAt - first.createdAt),
      cls: "x",
    });
  }
  return items;
}
