import { describe, expect, test } from "bun:test";
import { parseMetrics, parseModels } from "../src/engine/mlxserve.ts";
import {
  buildSample,
  computeRates,
  EMPTY_LIVE,
  type Reading,
} from "../src/sample.ts";
import metricsFixture from "./fixtures/metrics.json";
import modelsFixture from "./fixtures/models.json";

// A reading derived from the fixture with counter/gauge overrides, so each
// test states only what changes between the two ticks.
function reading(
  t: number,
  counters: Record<string, number> = {},
  gauges: Record<string, number> = {},
): Reading {
  const body = structuredClone(metricsFixture) as any;
  Object.assign(body.counters, counters);
  Object.assign(body.gauges, gauges);
  return { t, metrics: parseMetrics(body) };
}

// Rates from a to b with the live gauges tracked from a, as the sampler
// does across ticks.
const rates = (a: Reading, b: Reading, epoch = 0) =>
  computeRates(a, b, epoch, computeRates(null, a, epoch).live);

describe("computeRates", () => {
  test("no previous reading: no rates, same epoch, gauges tracked", () => {
    const r = computeRates(null, reading(1000), 0);
    expect(r).toEqual({
      epoch: 0,
      windowMs: null,
      decodeTps: null,
      prefillTps: null,
      cacheHitPct: null,
      cacheTokenPct: null,
      ttftMs: null,
      live: {
        decode: { t: 1000, value: 26, rate: 0, moves: [], hold: 0 },
        prefill: { t: 1000, value: 0, rate: 0, moves: [], hold: 0 },
      },
    });
  });

  test("TTFT is the mean of requests finished in the window", () => {
    const a = reading(1000);
    const b = reading(2000);
    b.metrics.histograms.ttftSeconds = { count: 3, sum: 11.258592084 + 0.5 };
    expect(rates(a, b).ttftMs).toBe(250);
    expect(rates(a, reading(2000)).ttftMs).toBeNull();
  });

  test("idle window: zero token rates, no cache ratio", () => {
    const r = rates(reading(1000), reading(2000));
    expect(r.windowMs).toBe(1000);
    expect(r.decodeTps).toBe(0);
    expect(r.prefillTps).toBe(0);
    expect(r.cacheHitPct).toBeNull();
    expect(r.cacheTokenPct).toBeNull();
  });

  // Rates over a run of readings, tracking the live gauges tick to tick.
  function run(rs: Reading[]) {
    let live = computeRates(null, rs[0], 0).live;
    const out: { decode: number | null; prefill: number | null }[] = [];
    for (let i = 1; i < rs.length; i++) {
      const x = computeRates(rs[i - 1], rs[i], 0, live);
      live = x.live;
      out.push({ decode: x.decodeTps, prefill: x.prefillTps });
    }
    return out;
  }
  const decoding = (t: number, live: number) =>
    reading(t, {}, { generation_tokens_live: live, requests_running: 1 });
  const prefilling = (t: number, live: number) =>
    reading(t, {}, { prefill_tokens_live: live, requests_prefilling: 1 });

  test("decode tok/s between moves of the live gauge", () => {
    // the first move after idle has no base; the second is rated over the
    // span between them
    const out = run([reading(1000), decoding(2000, 130), decoding(4000, 190)]);
    expect(out.map((o) => o.decode)).toEqual([0, 30]);
  });

  test("a live gauge dropping means a new request started", () => {
    const out = run([
      decoding(1000, 500),
      decoding(2000, 12),
      decoding(3000, 40),
    ]);
    expect(out.map((o) => o.decode)).toEqual([0, 28]);
  });

  test("prefill is rated from the start of the phase", () => {
    // the phase flag flips at prefill start, the gauge lands a chunk later
    const out = run([
      reading(1000),
      prefilling(2000, 0),
      prefilling(3000, 0),
      prefilling(6000, 2048),
      prefilling(10000, 4096),
    ]);
    expect(out.map((o) => o.prefill)).toEqual([0, 0, 512, 512]);
  });

  test("a one-chunk prefill never shows on the live gauge: rate it at completion", () => {
    // A 52411-token prompt with 51836 cached: 575 computed tokens in one
    // chunk, 8.53 s of prefill. The engine logs 67.4 tok/s for it.
    const a = reading(1000, { prefill_tokens_total: 10354 });
    const b = reading(2000, { prefill_tokens_total: 10929 });
    b.metrics.histograms.prefillTimeSeconds = {
      count: a.metrics.histograms.prefillTimeSeconds.count + 1,
      sum: a.metrics.histograms.prefillTimeSeconds.sum + 8.53,
    };
    expect(rates(a, b).prefillTps).toBe(67.4);
    // no request finished: an idle window still reads 0
    expect(
      rates(a, reading(2000, { prefill_tokens_total: 10354 })).prefillTps,
    ).toBe(0);
  });

  test("a short answer is rated from its decode time at completion", () => {
    // 25 tokens in 1.2 s of decode: one gauge step, no live rate
    const a = reading(1000);
    const b = reading(2000, { generation_tokens_total: 26 + 25 });
    b.metrics.histograms.decodeTimeSeconds = {
      count: a.metrics.histograms.decodeTimeSeconds.count + 1,
      sum: a.metrics.histograms.decodeTimeSeconds.sum + 1.2,
    };
    expect(rates(a, b).decodeTps).toBe(20.8);
  });

  test("cache ratios come from counter deltas, not lifetime totals", () => {
    const a = reading(1000);
    const b = reading(2000, {
      prefix_cache_queries_total: 5,
      prefix_cache_hits_total: 4,
      prompt_tokens_total: 42781 + 10000,
      prefix_cache_tokens_total: 41933 + 7500,
    });
    const r = rates(a, b);
    // 3 hits of 4 new queries; 7500 of 10000 new prompt tokens
    expect(r.cacheHitPct).toBe(75);
    expect(r.cacheTokenPct).toBe(75);
  });

  test("a counter going backwards starts a new epoch with no rates", () => {
    const a = reading(1000);
    const b = reading(2000, {
      prompt_tokens_total: 12,
      requests_success_total: 0,
    });
    const r = rates(a, b, 3);
    expect(r.epoch).toBe(4);
    expect(r.windowMs).toBeNull();
    expect(r.decodeTps).toBeNull();
    expect(r.cacheHitPct).toBeNull();
    expect(r.live).toEqual(EMPTY_LIVE);
  });

  test("a non-positive window yields no rates", () => {
    const r = rates(reading(2000), reading(2000));
    expect(r.windowMs).toBeNull();
    expect(r.decodeTps).toBeNull();
  });
});

describe("buildSample", () => {
  test("memory split: weights from loaded models, hot cache estimated", () => {
    const cur = reading(5000);
    const models = parseModels(modelsFixture);
    const s = buildSample(cur, computeRates(reading(4000), cur, 0), models);
    const weights = 16971681558 + 21610065162;
    expect(s.engineUp).toBe(true);
    expect(s.t).toBe(5000);
    expect(s.mem.weights).toBe(weights);
    expect(s.mem.hotCacheEst).toBe(40846363996 - weights);
    expect(s.mem.procFootprint).toBe(39439 * 1024 * 1024);
    expect(s.mem.mlxPool).toBe(78704656);
    expect(s.models).toHaveLength(3);
  });

  test("hot cache estimate never goes negative", () => {
    const cur = reading(5000, {}, { mlx_active_bytes: 1 });
    const s = buildSample(
      cur,
      computeRates(null, cur, 0),
      parseModels(modelsFixture),
    );
    expect(s.mem.hotCacheEst).toBe(0);
  });
});

describe("computeRates live tracking", () => {
  const at = (t: number, live: number) =>
    reading(t, {}, { generation_tokens_live: live, requests_running: 1 });
  function run(rs: Reading[]) {
    let live = computeRates(null, rs[0], 0).live;
    const out: (number | null)[] = [];
    for (let i = 1; i < rs.length; i++) {
      const x = computeRates(rs[i - 1], rs[i], 0, live);
      live = x.live;
      out.push(x.decodeTps);
    }
    return out;
  }

  // The engine republishes the live gauges every 2 s; mlx-spy reads every
  // second, so the gauge is frozen on every other tick.
  test("a frozen gauge carries the rate while the request runs", () => {
    const out = run([
      at(1000, 100),
      at(2000, 100), // not republished yet
      at(3000, 140), // first move: no base
      at(4000, 140),
      at(5000, 190), // 50 over 2 s
      at(6000, 190),
      at(7000, 230), // 90 over the 4 s spanning the last two moves
    ]);
    expect(out).toEqual([0, 0, 0, 25, 25, 22.5]);
  });

  test("a step seen late and the next seen early average out", () => {
    // 44 tokens per 2 s step, observed after 3 s, 1 s, 2 s, 2 s
    const out = run([
      at(1000, 0),
      at(4000, 44),
      at(5000, 88),
      at(7000, 132),
      at(9000, 176),
    ]);
    expect(out).toEqual([0, 44, 29.3, 26.4]);
  });

  test("a completion's double-counted jump is ignored, the rate carried", () => {
    // 22 tok/s with two requests running; one finishes with 12284 tokens
    // and the gauge counts them twice for a publish, then drops back
    const done = (t: number, live: number, total: number) => {
      const r = reading(
        t,
        { generation_tokens_total: total },
        { generation_tokens_live: live, requests_running: 1 },
      );
      r.metrics.histograms.decodeTimeSeconds = { count: 2, sum: 100 };
      return r;
    };
    const base = reading(1000).metrics.counters.generationTokens;
    const out = run([
      at(1000, 40304),
      at(3000, 40348),
      at(5000, 40392),
      done(7000, 52720, base + 12284), // jump: total moved, in-flight not yet
      done(8000, 40436, base + 12284), // settled: back to the true value
      done(10000, 40480, base + 12284),
      done(12000, 40524, base + 12284),
    ]);
    expect(out).toEqual([0, 22, 22, 22, 22, 22]);
  });

  test("idle resets the rate; a long prefill goes stale", () => {
    const idle = (t: number, live: number) =>
      reading(t, {}, { generation_tokens_live: live });
    const out = run([
      at(1000, 100),
      at(3000, 140),
      at(5000, 180), // 20 tok/s
      idle(6000, 180),
      idle(7000, 180),
      at(8000, 180), // next request: prefilling, gauge frozen
      at(10000, 180),
      at(12000, 180),
      at(14000, 180), // > 5 s without a move: no carry
      at(16000, 220),
      at(18000, 260),
    ]);
    expect(out).toEqual([0, 20, 0, 0, 0, 0, 0, 0, 0, 20]);
  });
});
