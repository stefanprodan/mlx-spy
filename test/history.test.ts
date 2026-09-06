import { describe, expect, test } from "bun:test";
import { DAY_MS, History, RING_SIZE } from "../src/history.ts";
import type { Sample } from "../src/sample.ts";

function sample(t: number, over: Partial<Sample> = {}): Sample {
  return {
    t,
    engineUp: true,
    epoch: 0,
    windowMs: 1000,
    decodeTps: 30,
    prefillTps: 0,
    requestsRunning: 1,
    requestsWaiting: 0,
    cacheHitPct: null,
    cacheTokenPct: null,
    gpuPct: 50,
    enginePid: null,
    mem: {
      hostTotal: 96_000,
      hostFree: 20_000,
      hostInactive: 10_000,
      hostWired: 5_000,
      hostCompressed: 0,
      procFootprint: 1000,
      procRss: 900,
      weights: 800,
      hotCacheEst: 100,
      mlxActive: 900,
      mlxPool: 10,
    },
    disk: [{ path: "/x/fp", bytes: 300, modelId: null }],
    models: [],
    ...over,
  };
}

describe("History", () => {
  test("ring buffer keeps the last hour", () => {
    const h = new History(":memory:");
    for (let i = 0; i < RING_SIZE + 10; i++) h.push(sample(i * 1000));
    expect(h.recent(RING_SIZE + 100)).toHaveLength(RING_SIZE);
    expect(h.latest()?.t).toBe((RING_SIZE + 9) * 1000);
    expect(h.recent(2).map((s) => s.t)).toEqual([
      (RING_SIZE + 8) * 1000,
      (RING_SIZE + 9) * 1000,
    ]);
    h.close();
  });

  test("1h series is raw 1 s points in columnar form", () => {
    const h = new History(":memory:");
    const now = 10_000_000;
    for (let i = 0; i < 100; i++) {
      h.push(sample(now - i * 1000, { decodeTps: i, cacheHitPct: null }));
    }
    const s = h.series("1h", now);
    expect(s.t).toHaveLength(100);
    expect(s.t[0]).toBe(now - 99_000);
    expect(s.decodeTps[0]).toBe(99);
    expect(s.cacheHitPct[0]).toBeNull();
    expect(s.weights[0]).toBe(800);
    expect(s.hostFree[0]).toBe(20_000);
    expect(s.diskBytes[0]).toBe(300);
    h.close();
  });

  test("longer ranges bucket to about 900 points, averaging rates", () => {
    const h = new History(":memory:");
    const now = 6 * 3_600_000; // exactly 6h of history at 1 Hz
    for (let i = 0; i < 6 * 3600; i++) {
      h.push(
        sample(now - i * 1000, {
          decodeTps: i % 2 === 0 ? 10 : 20,
          requestsRunning: i % 24 === 0 ? 3 : 0,
          epoch: i < 100 ? 1 : 0,
        }),
      );
    }
    const s = h.series("6h", now);
    // 6h / 900 = 24 s buckets
    expect(s.t.length).toBeGreaterThanOrEqual(899);
    expect(s.t.length).toBeLessThanOrEqual(901);
    expect(s.t[1] - s.t[0]).toBe(24_000);
    expect(s.decodeTps[10]).toBe(15);
    // queue depth keeps the max inside the bucket
    expect(s.requestsRunning[10]).toBe(3);
    // the epoch bump in the last 100 s shows on the last buckets
    expect(s.epoch.at(-1)).toBe(1);
    expect(s.epoch[0]).toBe(0);
    h.close();
  });

  test("series is empty outside the range", () => {
    const h = new History(":memory:");
    h.push(sample(1000));
    expect(h.series("1h", 3 * 3_600_000).t).toEqual([]);
    h.close();
  });

  test("retention prunes rows older than the window", () => {
    const h = new History(":memory:", 1);
    const now = 3 * DAY_MS;
    h.push(sample(now - 2 * DAY_MS)); // old
    h.push(sample(now - 1000)); // fresh, first prune runs here too
    expect(h.count()).toBe(1);
    // prune is throttled to once a minute: a row pushed within the minute
    // that is already stale survives until the next prune
    h.push(sample(now - DAY_MS - 5000));
    expect(h.count()).toBe(2);
    h.push(sample(now + 61_000));
    expect(h.count()).toBe(2);
    h.close();
  });

  test("sampler state round-trips and defaults when absent", () => {
    const h = new History(":memory:");
    expect(h.loadSamplerState()).toEqual({ epoch: 0, counters: null });
    const counters = {
      promptTokens: 1,
      prefillTokens: 2,
      cachedPromptTokens: 3,
      generationTokens: 4,
      requestsSuccess: 5,
      requestsCancelled: 6,
      cacheQueries: 7,
      cacheHits: 8,
    };
    h.saveSamplerState({ epoch: 3, counters });
    expect(h.loadSamplerState()).toEqual({ epoch: 3, counters });
    h.close();
  });

  test("engine-down samples store nulls, not zeros, for rates", () => {
    const h = new History(":memory:");
    h.push(
      sample(5000, {
        engineUp: false,
        decodeTps: null,
        prefillTps: null,
        requestsRunning: 0,
      }),
    );
    const s = h.series("1h", 5000);
    expect(s.engineUp).toEqual([0]);
    expect(s.decodeTps).toEqual([null]);
    h.close();
  });
});

describe("History migration", () => {
  test("adds the host columns to a pre-existing samples table", () => {
    const { Database } = require("bun:sqlite");
    const path = `${require("node:os").tmpdir()}/mlx-spy-migrate-${process.pid}.sqlite`;
    const old = new Database(path, { create: true });
    old.run(`CREATE TABLE samples (
      t INTEGER PRIMARY KEY, engine_up INTEGER NOT NULL, epoch INTEGER NOT NULL,
      decode_tps REAL, prefill_tps REAL, requests_running INTEGER NOT NULL,
      requests_waiting INTEGER NOT NULL, cache_hit_pct REAL, cache_token_pct REAL,
      gpu_pct REAL NOT NULL, proc_footprint INTEGER NOT NULL, weights INTEGER NOT NULL,
      hot_cache_est INTEGER NOT NULL, mlx_active INTEGER NOT NULL, mlx_pool INTEGER NOT NULL)`);
    old.run(
      "INSERT INTO samples VALUES (1000, 1, 0, 1, 2, 0, 0, NULL, NULL, 0, 5, 4, 1, 5, 0)",
    );
    old.close();
    try {
      const h = new History(path);
      const s = h.series("1h", 1000);
      expect(s.t).toEqual([1000]);
      expect(s.hostFree).toEqual([0]);
      h.push(sample(2000));
      expect(h.series("1h", 2000).diskBytes).toEqual([0, 300]);
      h.close();
    } finally {
      require("node:fs").rmSync(path, { force: true });
      require("node:fs").rmSync(`${path}-wal`, { force: true });
      require("node:fs").rmSync(`${path}-shm`, { force: true });
    }
  });
});
