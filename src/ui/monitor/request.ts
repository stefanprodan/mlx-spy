// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Sample } from "../../sample.ts";
import { count } from "../format.ts";

export type RequestMemory = {
  startedAt: number | null;
  prefillTps: number | null;
  decodeTps: number | null;
};

export const initialMemory: RequestMemory = {
  startedAt: null,
  prefillTps: null,
  decodeTps: null,
};

export type RequestBarModel = {
  state: string;
  stateClass: string;
  when: string;
  tokens: string;
  barClass: string;
  prefillWidth: number;
  decodeWidth: number;
  prefillText: string;
  cachedText: string;
  prefillRateText: string;
  decodeText: string;
  totalText: string;
  waitingText: string;
};

const fmtStamp = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const whole = (v: number) => `${Math.max(1, Math.round(v))}`;
const short = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${seconds}s`;
};
const tps = (tokens: number, ms: number) =>
  tokens > 0 && ms > 0 ? `${whole((tokens / ms) * 1000)} tok/s` : "";
// A phone wraps between facts, never inside one.
const join = (...parts: string[]) =>
  parts
    .filter(Boolean)
    .map((part) => part.replace(/ /g, "\u00a0"))
    .join(" · ");

const idle = (): RequestBarModel => ({
  state: "idle",
  stateClass: "cur-state",
  when: "",
  tokens: "",
  barClass: "cur-bar",
  prefillWidth: 0,
  decodeWidth: 0,
  prefillText: "",
  cachedText: "",
  prefillRateText: "",
  decodeText: "",
  totalText: "No inflight requests",
  waitingText: "",
});

// The request bar is engine-wide while work is in flight because the engine
// reports counts, not requests. Finished values come from request deltas.
export function requestBar(
  memory: RequestMemory,
  sample: Sample | null,
): { memory: RequestMemory; bar: RequestBarModel } {
  if (!sample) return { memory, bar: idle() };
  const current = sample.request;
  const last = sample.lastRequest;
  if (current && sample.engineUp) {
    const open = Math.max(sample.requestsRunning, sample.requestsPrefilling);
    const running = Math.max(1, open);
    const prefilling = sample.requestsPrefilling > 0;
    const elapsed = Math.max(1, sample.t - current.startedAt);
    const known = current.prefillMs + current.decodeMs || 1;
    let next = memory;
    if (current.startedAt !== memory.startedAt) {
      next = {
        startedAt: current.startedAt,
        prefillTps: null,
        decodeTps: null,
      };
    }
    // A short prefill can publish its only rate on the tick the phase ends.
    if (
      (sample.prefillTps ?? 0) > 0 &&
      (prefilling || next.prefillTps === null)
    ) {
      next = { ...next, prefillTps: sample.prefillTps };
    }
    if (!prefilling && (sample.decodeTps ?? 0) > 0) {
      next = { ...next, decodeTps: sample.decodeTps };
    }
    // Rates seen during each phase stay on the bar after that phase ends,
    // unlike the tiles' live values.
    const rate = (value: number | null) =>
      value ? `${whole(value)} tok/s` : "";
    return {
      memory: next,
      bar: {
        state: running > 1 ? `${running} in flight` : "in flight",
        stateClass: "cur-state on",
        when: fmtStamp.format(current.startedAt),
        tokens: `${count(sample.inflightTokens)} tok generating`,
        barClass: `cur-bar running${prefilling ? " prefilling" : ""}`,
        prefillWidth: (current.prefillMs / known) * 100,
        decodeWidth: (current.decodeMs / known) * 100,
        prefillText: current.prefillMs
          ? join(`prefill ${short(current.prefillMs)}`, rate(next.prefillTps))
          : "",
        cachedText: "",
        prefillRateText: "",
        decodeText: current.decodeMs
          ? join(`decode ${short(current.decodeMs)}`, rate(next.decodeTps))
          : "",
        totalText: `${short(elapsed)} · ${prefilling ? "prefilling" : "decoding"}`,
        waitingText:
          sample.requestsWaiting > 0 ? `${sample.requestsWaiting} waiting` : "",
      },
    };
  }
  if (!last) return { memory, bar: idle() };

  const known = last.prefillMs + last.decodeMs || 1;
  // The prompt is the context the request ran with. The part the engine did
  // not compute came from the prefix cache and is unknown for a cancellation.
  const prompt = last.promptTokens;
  const cached = prompt - last.prefillTokens;
  // The start can be observed up to one gauge publication late, so the span
  // is never shorter than the engine's own phase times.
  const span = Math.max(
    last.startedAt == null ? 0 : last.finishedAt - last.startedAt,
    known,
  );
  return {
    memory,
    bar: {
      state: last.count > 1 ? `last ${last.count} requests` : "last request",
      stateClass: "cur-state",
      when: fmtStamp.format(last.startedAt ?? last.finishedAt),
      tokens: `${count(last.generated)} tok generated`,
      barClass: `cur-bar${last.cancelled ? " cancelled" : ""}`,
      prefillWidth: (last.prefillMs / known) * 100,
      decodeWidth: (last.decodeMs / known) * 100,
      prefillText: join(
        last.prefillMs ? `prefill ${short(last.prefillMs)}` : "",
        prompt > 0 ? `${count(prompt)} tok` : "",
      ),
      cachedText:
        cached > 0 ? ` · ${whole((cached / prompt) * 100)}%\u00a0cached` : "",
      // The rate covers tokens the engine computed, not cached tokens.
      prefillRateText:
        last.prefillTokens > 0
          ? ` · ${tps(last.prefillTokens, last.prefillMs).replace(" ", "\u00a0")}`
          : "",
      decodeText: last.decodeMs
        ? join(
            `decode ${short(last.decodeMs)}`,
            tps(last.generated, last.decodeMs),
          )
        : "",
      totalText: `${short(span)} · ${last.cancelled ? "cancelled" : "done"}`,
      waitingText: "",
    },
  };
}
