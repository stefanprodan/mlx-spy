import { describe, expect, test } from "bun:test";
import { parseMetrics } from "../src/engine/mlxserve.ts";
import {
  EMPTY_REQUESTS,
  type RequestState,
  trackRequests,
} from "../src/requests.ts";
import type { Reading } from "../src/sample.ts";
import metricsFixture from "./fixtures/metrics.json";

// A reading at t with gauge overrides and, for a completion, the counter
// and histogram advances of the finished request.
function reading(
  t: number,
  gauges: Record<string, number> = {},
  done: {
    generated?: number;
    promptTokens?: number;
    prefillTokens?: number;
    prefillSecs?: number;
    decodeSecs?: number;
    ttftSecs?: number;
    cancelled?: boolean;
    n?: number;
  } | null = null,
): Reading {
  const body = structuredClone(metricsFixture) as any;
  Object.assign(body.gauges, gauges);
  if (done) {
    const n = done.n ?? 1;
    body.counters.generation_tokens_total += done.generated ?? 0;
    body.counters.prompt_tokens_total +=
      done.promptTokens ?? done.prefillTokens ?? 0;
    body.counters.prefill_tokens_total += done.prefillTokens ?? 0;
    if (done.cancelled) body.counters.requests_cancelled_total += 1;
    else body.counters.requests_success_total += n;
    const h = body.histograms;
    h.decode_time_seconds.count += n;
    h.decode_time_seconds.sum += done.decodeSecs ?? 0;
    h.prefill_time_seconds.count += n;
    h.prefill_time_seconds.sum += done.prefillSecs ?? 0;
    h.time_to_first_token_seconds.count += n;
    h.time_to_first_token_seconds.sum += done.ttftSecs ?? 0;
  }
  return { t, metrics: parseMetrics(body) };
}

// Run a script of readings through the tracker as the sampler does.
function run(script: Reading[], state: RequestState = EMPTY_REQUESTS) {
  const out: RequestState[] = [];
  let prev: Reading | null = null;
  for (const r of script) {
    state = trackRequests(state, prev, r);
    out.push(state);
    prev = r;
  }
  return out;
}

describe("trackRequests", () => {
  test("idle engine: nothing in flight, the last request is kept", () => {
    const last = {
      startedAt: 1,
      finishedAt: 2,
      count: 1,
      cancelled: false,
      generated: 3,
      promptTokens: 4,
      prefillTokens: 4,
      prefillMs: 5,
      decodeMs: 6,
      ttftMs: 7,
    };
    const [a, b] = run([reading(1000), reading(2000)], {
      ...EMPTY_REQUESTS,
      last,
    });
    expect(a.inFlight).toBeNull();
    expect(b.inFlight).toBeNull();
    expect(b.last).toBe(last);
  });

  test("a request: starts when the count goes up, phases accumulate, completes", () => {
    const s = run([
      reading(1000),
      reading(2000, { requests_running: 1, requests_prefilling: 1 }),
      reading(3000, { requests_running: 1, requests_prefilling: 1 }),
      reading(4000, { requests_running: 1 }),
      reading(6000, { requests_running: 1 }),
      reading(
        7000,
        {},
        {
          generated: 120,
          promptTokens: 1000,
          prefillTokens: 900,
          prefillSecs: 2.2,
          decodeSecs: 3.1,
          ttftSecs: 2.3,
        },
      ),
      reading(8000),
    ]);
    expect(s[1].inFlight).toEqual({
      startedAt: 2000,
      prefillMs: 0,
      decodeMs: 0,
    });
    expect(s[2].inFlight).toEqual({
      startedAt: 2000,
      prefillMs: 1000,
      decodeMs: 0,
    });
    expect(s[4].inFlight).toEqual({
      startedAt: 2000,
      prefillMs: 2000,
      decodeMs: 2000,
    });
    expect(s[5].inFlight).toBeNull();
    expect(s[5].last).toEqual({
      startedAt: 2000,
      finishedAt: 7000,
      count: 1,
      cancelled: false,
      generated: 120,
      promptTokens: 1000,
      prefillTokens: 900,
      prefillMs: 2200,
      decodeMs: 3100,
      ttftMs: 2300,
    });
    expect(s[6].last).toBe(s[5].last);
    expect(s[6].starts).toEqual([]);
  });

  test("the prefill flag on a running request is not a second request", () => {
    const s = run([
      reading(1000),
      reading(2000, { requests_running: 1 }),
      reading(3000, { requests_running: 1, requests_prefilling: 1 }),
      reading(4000, { requests_running: 1 }),
      reading(5000, {}, { generated: 8, decodeSecs: 1 }),
    ]);
    expect(s[2].starts).toEqual([2000]);
    expect(s[3].inFlight?.prefillMs).toBe(1000);
    expect(s[4].last?.startedAt).toBe(2000);
    // a flag that flips before the slot is counted still opens one request
    const t = run([
      reading(1000),
      reading(2000, { requests_prefilling: 1 }),
      reading(3000, { requests_running: 1, requests_prefilling: 1 }),
    ]);
    expect(t[2].starts).toEqual([2000]);
  });

  test("gauges lagging the counters leave no phantom start behind", () => {
    const s = run([
      reading(1000, { requests_running: 2 }),
      // both completed, but the gauge still reads 2
      reading(
        2000,
        { requests_running: 2 },
        { generated: 30, decodeSecs: 2, n: 2 },
      ),
      reading(3000, { requests_running: 1 }),
      reading(4000),
    ]);
    // the stale count is not a new request: the bar shows the last one
    expect(s[1].starts).toEqual([]);
    expect(s[1].inFlight).toBeNull();
    expect(s[2].inFlight).toBeNull();
    // the drop right after the completion is lag, not a cancel
    expect(s[2].last?.count).toBe(2);
    expect(s[2].last?.cancelled).toBe(false);
    expect(s[3].last).toBe(s[1].last);
    expect(s[3].inFlight).toBeNull();
  });

  test("a start right after a completion is seen once the gauge is trusted", () => {
    const s = run([
      reading(1000, { requests_running: 1 }),
      // one completed and another started, the count never dropped
      reading(2000, { requests_running: 1 }, { generated: 9, decodeSecs: 1 }),
      reading(3000, { requests_running: 1 }),
      reading(6000, { requests_running: 1 }),
      reading(9000, {}, { generated: 5, decodeSecs: 1 }),
    ]);
    expect(s[1].last?.startedAt).toBe(1000);
    expect(s[1].inFlight).toBeNull();
    expect(s[2].inFlight).toBeNull();
    // past the lag window the count is believed, from zero
    expect(s[3].starts).toEqual([6000]);
    expect(s[3].inFlight).toEqual({
      startedAt: 6000,
      prefillMs: 0,
      decodeMs: 0,
    });
    expect(s[4].last?.startedAt).toBe(6000);
    expect(s[4].inFlight).toBeNull();
  });

  test("a request that vanishes without a completion was cancelled", () => {
    const s = run([
      reading(1000),
      reading(2000, { requests_running: 1, requests_prefilling: 1 }),
      reading(3000, { requests_running: 1 }),
      // the live gauge counted 40 tokens for it on the last read
      reading(5000, { requests_running: 1, generation_tokens_live: 66 }),
      reading(6000),
    ]);
    expect(s[4].inFlight).toBeNull();
    expect(s[4].last).toEqual({
      startedAt: 2000,
      finishedAt: 6000,
      count: 1,
      cancelled: true,
      generated: 40,
      promptTokens: 0,
      prefillTokens: 0,
      prefillMs: 1000,
      decodeMs: 2000,
      ttftMs: null,
    });
    expect(s[4].starts).toEqual([]);
  });

  test("a cancel inside the lag window after a completion is still seen", () => {
    const s = run([
      reading(1000),
      reading(2000, { requests_running: 2 }),
      // one completed, the gauge still reads 2
      reading(
        3000,
        { requests_running: 2, generation_tokens_live: 40 },
        { generated: 9, decodeSecs: 1 },
      ),
      // the other one's client went away: below the known starts
      reading(4000),
      reading(5000),
    ]);
    expect(s[2].starts).toEqual([2000]);
    expect(s[3].inFlight).toBeNull();
    expect(s[3].last?.cancelled).toBe(true);
    expect(s[3].last?.startedAt).toBe(2000);
    expect(s[3].last?.generated).toBe(5);
    expect(s[4].last).toBe(s[3].last);
  });

  test("a cancelled request is marked as such", () => {
    const s = run([
      reading(1000, { requests_running: 1 }),
      reading(2000, {}, { generated: 5, decodeSecs: 0.5, cancelled: true }),
    ]);
    expect(s[1].last?.cancelled).toBe(true);
    expect(s[1].last?.generated).toBe(5);
  });

  test("two in flight: the oldest start survives the first completion", () => {
    const s = run([
      reading(1000),
      reading(2000, { requests_running: 1 }),
      reading(3000, { requests_running: 2 }),
      reading(4000, { requests_running: 1 }, { generated: 10, decodeSecs: 1 }),
      reading(5000, { requests_running: 1 }),
      reading(6000, {}, { generated: 20, decodeSecs: 2 }),
    ]);
    expect(s[2].starts).toEqual([2000, 3000]);
    expect(s[2].inFlight?.startedAt).toBe(2000);
    // the first to finish is taken to be the first that started
    expect(s[3].last?.startedAt).toBe(2000);
    expect(s[3].last?.generated).toBe(10);
    expect(s[3].inFlight?.startedAt).toBe(3000);
    // the engine never went idle: its phase clock keeps running
    expect(s[4].inFlight?.decodeMs).toBe(3000);
    expect(s[5].last?.startedAt).toBe(3000);
    expect(s[5].inFlight).toBeNull();
  });

  test("two completions in one tick merge into one entry", () => {
    const s = run([
      reading(1000, { requests_running: 2 }),
      reading(2000, {}, { generated: 30, decodeSecs: 2, n: 2 }),
    ]);
    expect(s[1].last?.count).toBe(2);
    expect(s[1].last?.generated).toBe(30);
  });

  test("two in flight, one finishing: the other keeps its start and clock", () => {
    const s = run([
      reading(1000, { requests_running: 1 }),
      reading(2000, { requests_running: 2 }),
      reading(3000, { requests_running: 1 }, { generated: 9, decodeSecs: 1 }),
      reading(4000, { requests_running: 1 }),
    ]);
    expect(s[2].last?.startedAt).toBe(1000);
    expect(s[2].starts).toEqual([2000]);
    expect(s[2].inFlight?.startedAt).toBe(2000);
    // the engine never went idle: its phase clock runs since the first start
    expect(s[3].inFlight?.decodeMs).toBe(3000);
  });

  test("no previous reading: a busy engine starts tracking now, without a start", () => {
    const last = {
      startedAt: 1,
      finishedAt: 2,
      count: 1,
      cancelled: false,
      generated: 3,
      promptTokens: 4,
      prefillTokens: 4,
      prefillMs: 5,
      decodeMs: 6,
      ttftMs: null,
    };
    const s = trackRequests(
      {
        starts: [500],
        inFlight: { startedAt: 500, prefillMs: 9, decodeMs: 9 },
        last,
        doneAt: null,
      },
      null,
      reading(1000, { requests_running: 1 }),
    );
    expect(s.inFlight).toEqual({ startedAt: 1000, prefillMs: 0, decodeMs: 0 });
    expect(s.last).toBe(last);
  });

  test("a completion whose start was never seen has no start time", () => {
    const s = run([
      reading(1000, { requests_running: 1 }),
      reading(2000, {}, { generated: 4, decodeSecs: 1 }),
    ]);
    // the first reading opens a request at its own time
    expect(s[1].last?.startedAt).toBe(1000);
    const t = run([
      reading(1000),
      // a request started and finished between two ticks
      reading(2000, {}, { generated: 4, decodeSecs: 1 }),
    ]);
    expect(t[1].last?.startedAt).toBeNull();
    expect(t[1].last?.generated).toBe(4);
  });
});
