// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The engine reports requests as counts and totals, never as a list, so the
// request bar tracks the engine as a whole: when the oldest open request
// started, how long the engine has spent prefilling and decoding since, and
// what the last finished request cost. Starts are seen as the running count
// going up between two readings; a completion is the decode-time histogram
// counting one more request, and its counter deltas are that request's own
// numbers (two completions in one tick merge into one entry that says so).
// With one request in flight, the common case, the picture is exact.

import type { Reading } from "./sample.ts";

export type InFlight = {
  startedAt: number; // unix ms, the oldest request still open
  prefillMs: number; // engine time spent with a prefill running
  decodeMs: number; // engine time spent generating with no prefill
};

export type LastRequest = {
  startedAt: number | null; // null when the start was not seen (restart)
  finishedAt: number;
  count: number; // requests that completed in the same tick
  cancelled: boolean;
  generated: number; // tokens
  promptTokens: number; // the prompt, cached or not (0 when unknown)
  prefillTokens: number; // prompt tokens computed (not cached)
  prefillMs: number; // the engine's own timings
  decodeMs: number;
  ttftMs: number | null;
};

export type RequestState = {
  starts: number[]; // start times of the open requests, oldest first
  inFlight: InFlight | null;
  last: LastRequest | null;
  doneAt: number | null; // the last tick a completion was counted
};

export const EMPTY_REQUESTS: RequestState = {
  starts: [],
  inFlight: null,
  last: null,
  doneAt: null,
};

// The engine's gauges are republished every 2 s while its counters move at
// once, so after a completion the running count can read stale for a read
// or two. A request that disappears from the count without a completion
// inside this window is that lag; later, it is a client that went away,
// which the engine counts nowhere (no counter, no histogram) and mlx-spy
// records as cancelled with what it saw of it.
const GAUGE_LAG_MS = 3000;

// mlx-serve counts a prefilling request in requests_running too (prefill
// runs on an in-flight slot); the max covers a flag that flips first
const open = (r: Reading) =>
  Math.max(
    r.metrics.gauges.requestsRunning,
    r.metrics.gauges.requestsPrefilling,
  );

// One tick. `prev` is null when the window broke (first reading, engine
// restart or outage), which forgets the open requests but keeps the last
// finished one.
export function trackRequests(
  state: RequestState,
  prev: Reading | null,
  cur: Reading,
): RequestState {
  const running = open(cur) > 0;
  if (!prev) {
    return {
      starts: running ? [cur.t] : [],
      inFlight: running
        ? { startedAt: cur.t, prefillMs: 0, decodeMs: 0 }
        : null,
      last: state.last,
      doneAt: null,
    };
  }
  const dt = Math.max(0, cur.t - prev.t);
  const a = prev.metrics;
  const b = cur.metrics;
  const done =
    b.histograms.decodeTimeSeconds.count - a.histograms.decodeTimeSeconds.count;
  let starts = state.starts;
  let last = state.last;
  if (done > 0) {
    const ttftN =
      b.histograms.ttftSeconds.count - a.histograms.ttftSeconds.count;
    const ms = (h: "prefillTimeSeconds" | "decodeTimeSeconds") =>
      Math.round((b.histograms[h].sum - a.histograms[h].sum) * 1000);
    last = {
      startedAt: starts[0] ?? null,
      finishedAt: cur.t,
      count: done,
      cancelled: b.counters.requestsCancelled > a.counters.requestsCancelled,
      generated: b.counters.generationTokens - a.counters.generationTokens,
      promptTokens: b.counters.promptTokens - a.counters.promptTokens,
      prefillTokens: b.counters.prefillTokens - a.counters.prefillTokens,
      prefillMs: ms("prefillTimeSeconds"),
      decodeMs: ms("decodeTimeSeconds"),
      ttftMs:
        ttftN > 0
          ? Math.round(
              ((b.histograms.ttftSeconds.sum - a.histograms.ttftSeconds.sum) /
                ttftN) *
                1000,
            )
          : null,
    };
    starts = starts.slice(done);
  }
  const doneAt = done > 0 ? cur.t : state.doneAt;
  const lag = doneAt != null && cur.t - doneAt <= GAUGE_LAG_MS;
  // more open than known starts is a start (a request that started and
  // ended between two ticks was never seen open and has none); inside the
  // window after a completion the count may still include the finished
  // request, so a rise there waits until the gauge is trusted again
  const started = lag ? 0 : Math.max(0, open(cur) - starts.length);
  for (let i = 0; i < started; i++) starts = [...starts, cur.t];
  // the gauge only ever lags above the known starts (completions leave the
  // count before they leave it), so a count below them is never lag
  const dropped = Math.max(0, starts.length - open(cur));
  if (dropped > 0) {
    // gone without a completion: a cancelled request, known only from the
    // live gauges of the previous read and the phase clock
    last = {
      startedAt: starts[0] ?? null,
      finishedAt: cur.t,
      count: dropped,
      cancelled: true,
      generated: Math.max(
        0,
        a.gauges.generationTokensLive - a.counters.generationTokens,
      ),
      promptTokens: 0,
      prefillTokens: 0,
      prefillMs: state.inFlight?.prefillMs ?? 0,
      decodeMs: state.inFlight?.decodeMs ?? 0,
      ttftMs: null,
    };
    starts = starts.slice(dropped);
  }
  if (!running || !starts.length) {
    return { starts: [], inFlight: null, last, doneAt };
  }
  // the engine is busy: time since the previous tick went to the phase it
  // was in at that tick
  // phase, unless every open request started this tick (the engine was
  // idle, or finished everything and started afresh): count from zero
  const prevIn = state.inFlight;
  const wasPrefilling = a.gauges.requestsPrefilling > 0;
  const fresh = starts.every((t) => t === cur.t);
  const inFlight: InFlight =
    prevIn && !fresh
      ? {
          startedAt: starts[0],
          prefillMs: prevIn.prefillMs + (wasPrefilling ? dt : 0),
          decodeMs: prevIn.decodeMs + (wasPrefilling ? 0 : dt),
        }
      : { startedAt: starts[0], prefillMs: 0, decodeMs: 0 };
  return { starts, inFlight, last, doneAt };
}
