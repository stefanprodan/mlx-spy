// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Sample history: a ring buffer of the last hour for cheap backfill of new
// dashboard connections, and bun:sqlite for the 7 day series. Retention is
// enforced from the writer, not by a separate job. The history exists from
// version one so graphs survive reloads and every tab sees the same series.

import { Database } from "bun:sqlite";
import type { EngineCounters } from "./engine/types.ts";
import type { LastRequest } from "./requests.ts";
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
  hostTotal: number[];
  hostFree: number[];
  hostInactive: number[];
  hostWired: number[];
  hostCompressed: number[];
  procRss: number[];
  diskBytes: number[];
  ttftMs: (number | null)[]; // mean over the bucket, weighted by ttftN
  ttftN: number[]; // requests the mean covers
  generationTokens: number[];
  requestsTotal: number[];
  promptTokens: number[];
  cachedPromptTokens: number[];
  requestsCancelled: number[];
};

// What the sampler needs back after a restart to keep the epoch honest:
// the last counters it saw, so the first new reading can be compared.
export type SamplerState = {
  epoch: number;
  counters: EngineCounters | null;
  lastRequest: LastRequest | null;
};

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
      mlx_pool INTEGER NOT NULL,
      host_total INTEGER NOT NULL DEFAULT 0,
      host_free INTEGER NOT NULL DEFAULT 0,
      host_inactive INTEGER NOT NULL DEFAULT 0,
      host_wired INTEGER NOT NULL DEFAULT 0,
      host_compressed INTEGER NOT NULL DEFAULT 0,
      proc_rss INTEGER NOT NULL DEFAULT 0,
      disk_bytes INTEGER NOT NULL DEFAULT 0,
      ttft_ms REAL,
      ttft_n INTEGER NOT NULL DEFAULT 0,
      generation_tokens INTEGER NOT NULL DEFAULT 0,
      requests_total INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      cached_prompt_tokens INTEGER NOT NULL DEFAULT 0,
      requests_cancelled INTEGER NOT NULL DEFAULT 0
    )`);
    this.migrate();
    this.db.run(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    // The models the engine lists, so the favorite (the daily driver, one
    // at most) survives engine restarts and page reloads. Sizes and state
    // stay live from the engine.
    this.db.run(`CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      favorite INTEGER NOT NULL DEFAULT 0,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    )`);
    this.migrateModels();
    // columns named: a migrated file appends them in a different order than
    // CREATE TABLE lists them
    this.insert = this.db.prepare(`INSERT OR REPLACE INTO samples (
      t, engine_up, epoch, decode_tps, prefill_tps, requests_running,
      requests_waiting, cache_hit_pct, cache_token_pct, gpu_pct, proc_footprint,
      weights, hot_cache_est, mlx_active, mlx_pool, host_total, host_free,
      host_inactive, host_wired, host_compressed, proc_rss, disk_bytes,
      ttft_ms, ttft_n, generation_tokens, requests_total, prompt_tokens,
      cached_prompt_tokens, requests_cancelled
    ) VALUES (
      $t, $engineUp, $epoch, $decodeTps, $prefillTps, $requestsRunning,
      $requestsWaiting, $cacheHitPct, $cacheTokenPct, $gpuPct, $procFootprint,
      $weights, $hotCacheEst, $mlxActive, $mlxPool, $hostTotal, $hostFree,
      $hostInactive, $hostWired, $hostCompressed, $procRss, $diskBytes,
      $ttftMs, $ttftN, $generationTokens, $requestsTotal, $promptTokens,
      $cachedPromptTokens, $requestsCancelled)`);
    this.prune = this.db.prepare("DELETE FROM samples WHERE t < $before");
  }

  // Columns added after the first release get appended to an existing file;
  // CREATE TABLE IF NOT EXISTS leaves an old schema alone.
  private migrate() {
    const have = new Set(
      (
        this.db.query("PRAGMA table_info(samples)").all() as { name: string }[]
      ).map((c) => c.name),
    );
    for (const col of [
      "host_total",
      "host_free",
      "host_inactive",
      "host_wired",
      "host_compressed",
      "proc_rss",
      "disk_bytes",
      "generation_tokens",
      "requests_total",
      "prompt_tokens",
      "cached_prompt_tokens",
      "requests_cancelled",
      "ttft_n",
    ]) {
      if (!have.has(col)) {
        this.db.run(
          `ALTER TABLE samples ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`,
        );
      }
    }
    if (!have.has("ttft_ms")) {
      this.db.run("ALTER TABLE samples ADD COLUMN ttft_ms REAL");
    }
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
      hostTotal: s.mem.hostTotal,
      hostFree: s.mem.hostFree,
      hostInactive: s.mem.hostInactive,
      hostWired: s.mem.hostWired,
      hostCompressed: s.mem.hostCompressed,
      procRss: s.mem.procRss,
      diskBytes: s.disk.reduce((n, d) => n + d.bytes, 0),
      ttftMs: s.ttftMs,
      ttftN: s.ttftN,
      generationTokens: s.generatedTokens,
      requestsTotal: s.requestsTotal,
      promptTokens: s.promptTokens,
      cachedPromptTokens: s.cachedPromptTokens,
      requestsCancelled: s.requestsCancelled,
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
  // (SQL avg skips nulls, so idle buckets stay null), TTFT is weighted by
  // the requests each tick's mean covers, queue depths take the max so a
  // short burst is not averaged away, and the epoch and the lifetime
  // counters come from the bucket's last row, so a restart inside a bucket
  // shows on the bucket it landed in with that process's counters, never
  // the old process's higher ones.
  series(range: Range, now = Date.now()): Series {
    const spanMs = RANGES[range];
    // the hour stays raw (3600 points is fine for uPlot); longer ranges bucket
    const bucketMs =
      range === "1h"
        ? 1000
        : Math.max(1000, Math.ceil(spanMs / TARGET_POINTS / 1000) * 1000);
    const rows = this.db
      .query(
        `SELECT a.*, l.epoch, l.generation_tokens AS generationTokens,
          l.requests_total AS requestsTotal, l.prompt_tokens AS promptTokens,
          l.cached_prompt_tokens AS cachedPromptTokens,
          l.requests_cancelled AS requestsCancelled
        FROM (SELECT (b.t / $bucket) * $bucket AS t,
          min(engine_up) AS engineUp,
          avg(decode_tps) AS decodeTps, avg(prefill_tps) AS prefillTps,
          max(requests_running) AS requestsRunning,
          max(requests_waiting) AS requestsWaiting,
          avg(cache_hit_pct) AS cacheHitPct, avg(cache_token_pct) AS cacheTokenPct,
          avg(gpu_pct) AS gpuPct, avg(proc_footprint) AS procFootprint,
          avg(weights) AS weights, avg(hot_cache_est) AS hotCacheEst,
          avg(mlx_active) AS mlxActive, avg(mlx_pool) AS mlxPool,
          avg(host_total) AS hostTotal, avg(host_free) AS hostFree,
          avg(host_inactive) AS hostInactive, avg(host_wired) AS hostWired,
          avg(host_compressed) AS hostCompressed, avg(proc_rss) AS procRss,
          avg(disk_bytes) AS diskBytes,
          sum(ttft_ms * ttft_n) / nullif(sum(ttft_n), 0) AS ttftMs,
          sum(ttft_n) AS ttftN,
          max(b.t) AS lastT
        FROM samples b WHERE b.t >= $since AND b.t <= $now
        GROUP BY 1) a JOIN samples l ON l.t = a.lastT
        ORDER BY a.t`,
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
      hostTotal: [],
      hostFree: [],
      hostInactive: [],
      hostWired: [],
      hostCompressed: [],
      procRss: [],
      diskBytes: [],
      ttftMs: [],
      ttftN: [],
      generationTokens: [],
      requestsTotal: [],
      promptTokens: [],
      cachedPromptTokens: [],
      requestsCancelled: [],
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
      out.hostTotal.push(Math.round(r.hostTotal));
      out.hostFree.push(Math.round(r.hostFree));
      out.hostInactive.push(Math.round(r.hostInactive));
      out.hostWired.push(Math.round(r.hostWired));
      out.hostCompressed.push(Math.round(r.hostCompressed));
      out.procRss.push(Math.round(r.procRss));
      out.diskBytes.push(Math.round(r.diskBytes));
      out.ttftMs.push(r.ttftMs === null ? null : Math.round(r.ttftMs));
      out.ttftN.push(r.ttftN);
      out.generationTokens.push(r.generationTokens);
      out.requestsTotal.push(r.requestsTotal);
      out.promptTokens.push(r.promptTokens);
      out.cachedPromptTokens.push(r.cachedPromptTokens);
      out.requestsCancelled.push(r.requestsCancelled);
    }
    return out;
  }

  loadSamplerState(): SamplerState {
    const row = this.db
      .query("SELECT value FROM meta WHERE key = 'sampler'")
      .get() as { value: string } | null;
    const none = { epoch: 0, counters: null, lastRequest: null };
    if (!row) return none;
    try {
      const v = JSON.parse(row.value);
      return {
        epoch: typeof v.epoch === "number" ? v.epoch : 0,
        counters: v.counters ?? null,
        lastRequest: v.lastRequest ?? null,
      };
    } catch {
      return none;
    }
  }

  saveSamplerState(state: SamplerState) {
    this.db
      .query("INSERT OR REPLACE INTO meta (key, value) VALUES ('sampler', $v)")
      .run({ v: JSON.stringify(state) });
  }

  // The first cut of the table called the flag is_default.
  private migrateModels() {
    const cols = (
      this.db.query("PRAGMA table_info(models)").all() as { name: string }[]
    ).map((c) => c.name);
    if (cols.includes("is_default")) {
      this.db.run("ALTER TABLE models RENAME COLUMN is_default TO favorite");
    }
  }

  // The engine's current model list: new ids are added, ids the engine no
  // longer lists are dropped along with their favorite flag.
  syncModels(ids: string[], now = Date.now()) {
    const upsert = this.db.query(
      `INSERT INTO models (id, first_seen, last_seen) VALUES ($id, $t, $t)
       ON CONFLICT(id) DO UPDATE SET last_seen = $t`,
    );
    const drop = this.db.query("DELETE FROM models WHERE last_seen <> $t");
    this.db.transaction(() => {
      for (const id of ids) upsert.run({ id, t: now });
      drop.run({ t: now });
    })();
  }

  // Toggle: the id becomes the only favorite, or stops being one if it
  // already was. Returns the favorite after the call.
  toggleFavorite(id: string): string | null {
    const was = this.favorite();
    this.db
      .query("UPDATE models SET favorite = (id = $id AND $on)")
      .run({ id, on: was === id ? 0 : 1 });
    return this.favorite();
  }

  favorite(): string | null {
    const row = this.db
      .query("SELECT id FROM models WHERE favorite = 1 LIMIT 1")
      .get() as { id: string } | null;
    return row?.id ?? null;
  }

  // Wipe the samples, keeping the sampler state so the epoch stays honest.
  clear(): number {
    const n = this.count();
    this.db.run("DELETE FROM samples");
    this.ring.length = 0;
    return n;
  }

  close() {
    this.db.close();
  }
}
