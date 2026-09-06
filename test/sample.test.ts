import { describe, expect, test } from "bun:test";
import { parseMetrics, parseModels } from "../src/engine/mlxserve.ts";
import { buildSample, computeRates, type Reading } from "../src/sample.ts";
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

describe("computeRates", () => {
  test("no previous reading: no rates, same epoch", () => {
    const r = computeRates(null, reading(1000), 0);
    expect(r).toEqual({
      epoch: 0,
      windowMs: null,
      decodeTps: null,
      prefillTps: null,
      cacheHitPct: null,
      cacheTokenPct: null,
      ttftMs: null,
    });
  });

  test("TTFT is the mean of requests finished in the window", () => {
    const a = reading(1000);
    const b = reading(2000);
    b.metrics.histograms.ttftSeconds = { count: 3, sum: 11.258592084 + 0.5 };
    expect(computeRates(a, b, 0).ttftMs).toBe(250);
    expect(computeRates(a, reading(2000), 0).ttftMs).toBeNull();
  });

  test("idle window: zero token rates, no cache ratio", () => {
    const r = computeRates(reading(1000), reading(2000), 0);
    expect(r.windowMs).toBe(1000);
    expect(r.decodeTps).toBe(0);
    expect(r.prefillTps).toBe(0);
    expect(r.cacheHitPct).toBeNull();
    expect(r.cacheTokenPct).toBeNull();
  });

  test("live gauges advancing during a request give tok/s", () => {
    const a = reading(1000, {}, { generation_tokens_live: 100 });
    const b = reading(
      3000,
      {},
      { generation_tokens_live: 160, requests_running: 1 },
    );
    expect(computeRates(a, b, 0).decodeTps).toBe(30);
  });

  test("a live gauge dropping means a new request started", () => {
    const a = reading(1000, {}, { generation_tokens_live: 500 });
    const b = reading(
      2000,
      {},
      { generation_tokens_live: 12, requests_running: 1 },
    );
    expect(computeRates(a, b, 0).decodeTps).toBe(12);
  });

  test("prefill rate from prefill_tokens_live while prefilling", () => {
    const a = reading(1000, {}, { prefill_tokens_live: 0 });
    const b = reading(
      2000,
      {},
      { prefill_tokens_live: 640, requests_prefilling: 1 },
    );
    expect(computeRates(a, b, 0).prefillTps).toBe(640);
  });

  test("cache ratios come from counter deltas, not lifetime totals", () => {
    const a = reading(1000);
    const b = reading(2000, {
      prefix_cache_queries_total: 5,
      prefix_cache_hits_total: 4,
      prompt_tokens_total: 42781 + 10000,
      prefix_cache_tokens_total: 41933 + 7500,
    });
    const r = computeRates(a, b, 0);
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
    const r = computeRates(a, b, 3);
    expect(r.epoch).toBe(4);
    expect(r.windowMs).toBeNull();
    expect(r.decodeTps).toBeNull();
    expect(r.cacheHitPct).toBeNull();
  });

  test("a non-positive window yields no rates", () => {
    const r = computeRates(reading(2000), reading(2000), 0);
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

describe("computeRates live window", () => {
  test("bursty live gauge smooths over the base reading", () => {
    // the gauge moves every other second: 0, +40, +0, +40
    const r0 = reading(1000, {}, { generation_tokens_live: 100 });
    const r1 = reading(
      2000,
      {},
      { generation_tokens_live: 140, requests_running: 1 },
    );
    const r2 = reading(
      3000,
      {},
      { generation_tokens_live: 140, requests_running: 1 },
    );
    // one second windows alternate between 40 and 0
    expect(computeRates(r0, r1, 0).decodeTps).toBe(40);
    expect(computeRates(r1, r2, 0).decodeTps).toBe(0);
    // rated against a base two seconds back the line reads 20 both times
    expect(computeRates(r1, r2, 0, r0).decodeTps).toBe(20);
  });

  test("counters and epoch still come from the previous reading", () => {
    const r0 = reading(1000);
    const r1 = reading(2000, {
      prefix_cache_queries_total: 3,
      prefix_cache_hits_total: 2,
    });
    const r2 = reading(3000, {
      prefix_cache_queries_total: 4,
      prefix_cache_hits_total: 2,
    });
    const r = computeRates(r1, r2, 0, r0);
    expect(r.cacheHitPct).toBe(0); // 0 of 1 new query, not 1 of 3
    expect(r.windowMs).toBe(1000);
  });
});
