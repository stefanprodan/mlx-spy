// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Sample history: a ring buffer of the last hour for cheap backfill of new
// dashboard connections, and bun:sqlite for the 7 day series. Retention is
// enforced from the writer, not by a separate job. The history exists from
// version one so graphs survive reloads and every tab sees the same series.

import { Database } from "bun:sqlite";
import type { EngineCounters } from "./engine/types.ts";
import type { Sample } from "./sample.ts";

export const RING_SIZE = 3600; // one hour at 1 Hz
export const DAY_MS = 86_400_000;

export const RANGES = {
  "1h": 3_600_000,
  "6h": 21_600_000,
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
} as const;
export type Range = keyof typeof RANGES;

// About this many points per series regardless of range: 1h stays raw,
// longer ranges are averaged into buckets so a 7 day query is not 600k rows.
const TARGET_POINTS = 900;

// Columnar, ready for uPlot: one array per series, aligned on `t`.
export type Series = {
  t: number[];
  engineUp: (0 | 1)[];
  epoch: number[];
  decodeTps: (number | null)[];
  prefillTps: (number | null)[];
  requestsRunning: number[];
  requestsWaiting: number[];
  cacheHitPct: (number | null)[];
  cacheTokenPct: (number | null)[];
  gpuPct: number[];
  procFootprint: number[];
  weights: number[];
  hotCacheEst: number[];
  mlxActive: number[];
  mlxPool: number[];
};

// What the sampler needs back after a restart to keep the epoch honest:
// the last counters it saw, so the first new reading can be compared.
export type SamplerState = { epoch: number; counters: EngineCounters | null };

export class History {
  private readonly db: Database;
  private readonly ring: Sample[] = [];
  private readonly insert;
  private readonly prune;
  private readonly retentionMs: number;
  private lastPruneAt = 0;

  constructor(path: string, retentionDays = 7) {
    this.retentionMs = retentionDays * DAY_MS;
    this.db = new Database(path, { create: true, strict: true });
    // WAL keeps the 1 Hz writer from blocking history reads
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS samples (
      t INTEGER PRIMARY KEY,
      engine_up INTEGER NOT NULL,
      epoch INTEGER NOT NULL,
      decode_tps REAL,
      prefill_tps REAL,
      requests_running INTEGER NOT NULL,
      requests_waiting INTEGER NOT NULL,
      cache_hit_pct REAL,
      cache_token_pct REAL,
      gpu_pct REAL NOT NULL,
      proc_footprint INTEGER NOT NULL,
      weights INTEGER NOT NULL,
      hot_cache_est INTEGER NOT NULL,
      mlx_active INTEGER NOT NULL,
      mlx_pool INTEGER NOT NULL
    )`);
    this.db.run(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    this.insert = this.db.prepare(`INSERT OR REPLACE INTO samples VALUES (
      $t, $engineUp, $epoch, $decodeTps, $prefillTps, $requestsRunning,
      $requestsWaiting, $cacheHitPct, $cacheTokenPct, $gpuPct, $procFootprint,
      $weights, $hotCacheEst, $mlxActive, $mlxPool)`);
    this.prune = this.db.prepare("DELETE FROM samples WHERE t < $before");
  }

  push(s: Sample) {
    this.ring.push(s);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    this.insert.run({
      t: s.t,
      engineUp: s.engineUp ? 1 : 0,
      epoch: s.epoch,
      decodeTps: s.decodeTps,
      prefillTps: s.prefillTps,
      requestsRunning: s.requestsRunning,
      requestsWaiting: s.requestsWaiting,
      cacheHitPct: s.cacheHitPct,
      cacheTokenPct: s.cacheTokenPct,
      gpuPct: s.gpuPct,
      procFootprint: s.mem.procFootprint,
      weights: s.mem.weights,
      hotCacheEst: s.mem.hotCacheEst,
      mlxActive: s.mem.mlxActive,
      mlxPool: s.mem.mlxPool,
    });
    // once a minute is plenty; the delete is a range scan on the primary key
    if (s.t - this.lastPruneAt >= 60_000) {
      this.prune.run({ before: s.t - this.retentionMs });
      this.lastPruneAt = s.t;
    }
  }

  latest(): Sample | null {
    return this.ring.at(-1) ?? null;
  }

  recent(n: number): Sample[] {
    return this.ring.slice(-n);
  }

  count(): number {
    const row = this.db.query("SELECT count(*) AS n FROM samples").get() as {
      n: number;
    };
    return row.n;
  }

  // Series covering [now - range, now]. Bucket width grows with the range so
  // the point count stays near TARGET_POINTS; rates and ratios are averaged
  // (SQL avg skips nulls, so idle buckets stay null), queue depths take the
  // max so a short burst is not averaged away, epoch takes the max so a
  // restart inside a bucket shows on the bucket it landed in.
  series(range: Range, now = Date.now()): Series {
    const spanMs = RANGES[range];
    // the hour stays raw (3600 points is fine for uPlot); longer ranges bucket
    const bucketMs =
      range === "1h"
        ? 1000
        : Math.max(1000, Math.ceil(spanMs / TARGET_POINTS / 1000) * 1000);
    const rows = this.db
      .query(
        `SELECT (t / $bucket) * $bucket AS t,
          min(engine_up) AS engineUp, max(epoch) AS epoch,
          avg(decode_tps) AS decodeTps, avg(prefill_tps) AS prefillTps,
          max(requests_running) AS requestsRunning,
          max(requests_waiting) AS requestsWaiting,
          avg(cache_hit_pct) AS cacheHitPct, avg(cache_token_pct) AS cacheTokenPct,
          avg(gpu_pct) AS gpuPct, avg(proc_footprint) AS procFootprint,
          avg(weights) AS weights, avg(hot_cache_est) AS hotCacheEst,
          avg(mlx_active) AS mlxActive, avg(mlx_pool) AS mlxPool
        FROM samples WHERE t >= $since AND t <= $now
        GROUP BY 1 ORDER BY 1`,
      )
      .all({ bucket: bucketMs, since: now - spanMs, now }) as any[];
    const out: Series = {
      t: [],
      engineUp: [],
      epoch: [],
      decodeTps: [],
      prefillTps: [],
      requestsRunning: [],
      requestsWaiting: [],
      cacheHitPct: [],
      cacheTokenPct: [],
      gpuPct: [],
      procFootprint: [],
      weights: [],
      hotCacheEst: [],
      mlxActive: [],
      mlxPool: [],
    };
    for (const r of rows) {
      out.t.push(r.t);
      out.engineUp.push(r.engineUp ? 1 : 0);
      out.epoch.push(r.epoch);
      out.decodeTps.push(r.decodeTps);
      out.prefillTps.push(r.prefillTps);
      out.requestsRunning.push(r.requestsRunning);
      out.requestsWaiting.push(r.requestsWaiting);
      out.cacheHitPct.push(r.cacheHitPct);
      out.cacheTokenPct.push(r.cacheTokenPct);
      out.gpuPct.push(r.gpuPct);
      out.procFootprint.push(Math.round(r.procFootprint));
      out.weights.push(Math.round(r.weights));
      out.hotCacheEst.push(Math.round(r.hotCacheEst));
      out.mlxActive.push(Math.round(r.mlxActive));
      out.mlxPool.push(Math.round(r.mlxPool));
    }
    return out;
  }

  loadSamplerState(): SamplerState {
    const row = this.db
      .query("SELECT value FROM meta WHERE key = 'sampler'")
      .get() as { value: string } | null;
    if (!row) return { epoch: 0, counters: null };
    try {
      const v = JSON.parse(row.value);
      return {
        epoch: typeof v.epoch === "number" ? v.epoch : 0,
        counters: v.counters ?? null,
      };
    } catch {
      return { epoch: 0, counters: null };
    }
  }

  saveSamplerState(state: SamplerState) {
    this.db
      .query("INSERT OR REPLACE INTO meta (key, value) VALUES ('sampler', $v)")
      .run({ v: JSON.stringify(state) });
  }

  close() {
    this.db.close();
  }
}
