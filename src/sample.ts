// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One Sample per second: the engine's counters and gauges turned into rates
// over the window since the previous reading, joined with the host probes.
// The pure parts (rates, epoch detection, assembly) are here and unit
// tested; takeSample() does the I/O for --once.

import type { Engine, EngineMetrics, ModelInfo } from "./engine/types.ts";
import { cacheDirSizes } from "./host/disk.ts";
import { isLocalUrl } from "./host/local.ts";
import {
  type DiskDir,
  EMPTY_HOST,
  type HostProbes,
  type HostSnapshot,
} from "./host/types.ts";

export type Sample = {
  t: number; // unix ms
  engineUp: boolean;
  epoch: number; // bumps when the engine's counters go backwards (restart)
  windowMs: number | null; // length of the window the rates cover
  decodeTps: number | null;
  prefillTps: number | null;
  requestsRunning: number;
  requestsWaiting: number;
  cacheHitPct: number | null; // hits / queries over the window
  cacheTokenPct: number | null; // cached prompt tokens / prompt tokens, windowed
  gpuPct: number;
  enginePid: number | null; // only when the engine runs on this host
  mem: {
    hostTotal: number;
    hostFree: number;
    hostInactive: number;
    hostWired: number;
    hostCompressed: number;
    // engine process: libproc rusage when the pid is known, else what the
    // engine reports about itself (memory_mb)
    procFootprint: number;
    procRss: number; // 0 when the pid is unknown
    weights: number; // sum of bytesResident over loaded models
    hotCacheEst: number; // max(0, mlxActive - weights); no gauge exists yet
    mlxActive: number;
    mlxPool: number;
  };
  disk: DiskDir[]; // cache tier directories, refreshed every 30 s
  models: ModelInfo[];
};

export type Reading = { t: number; metrics: EngineMetrics };

export type Rates = {
  epoch: number;
  windowMs: number | null;
  decodeTps: number | null;
  prefillTps: number | null;
  cacheHitPct: number | null;
  cacheTokenPct: number | null;
};

const pct = (num: number, den: number) =>
  den > 0 ? Math.round((num / den) * 1000) / 10 : null;

// A *_live gauge holds the token count of the current request and drops back
// when a new one starts, so a negative delta means "new request, cur tokens
// so far" rather than a reset. With nothing running the line reads zero.
function liveRate(prev: number, cur: number, running: boolean, secs: number) {
  if (!running && cur === prev) return 0;
  const d = cur >= prev ? cur - prev : cur;
  return Math.round((d / secs) * 10) / 10;
}

// Pure: rates between two readings. A counter going backwards means the
// engine restarted: start a new epoch and publish no rates for that window.
export function computeRates(
  prev: Reading | null,
  cur: Reading,
  prevEpoch: number,
): Rates {
  const none = {
    windowMs: null,
    decodeTps: null,
    prefillTps: null,
    cacheHitPct: null,
    cacheTokenPct: null,
  };
  if (!prev) return { epoch: prevEpoch, ...none };
  const a = prev.metrics.counters;
  const b = cur.metrics.counters;
  const reset = (Object.keys(b) as (keyof typeof b)[]).some((k) => b[k] < a[k]);
  if (reset) return { epoch: prevEpoch + 1, ...none };
  const windowMs = cur.t - prev.t;
  if (windowMs <= 0) return { epoch: prevEpoch, ...none };
  const secs = windowMs / 1000;
  const g0 = prev.metrics.gauges;
  const g1 = cur.metrics.gauges;
  const running = g1.requestsRunning > 0 || g1.requestsPrefilling > 0;
  return {
    epoch: prevEpoch,
    windowMs,
    decodeTps: liveRate(
      g0.generationTokensLive,
      g1.generationTokensLive,
      running,
      secs,
    ),
    prefillTps: liveRate(
      g0.prefillTokensLive,
      g1.prefillTokensLive,
      running,
      secs,
    ),
    cacheHitPct: pct(
      b.cacheHits - a.cacheHits,
      b.cacheQueries - a.cacheQueries,
    ),
    cacheTokenPct: pct(
      b.cachedPromptTokens - a.cachedPromptTokens,
      b.promptTokens - a.promptTokens,
    ),
  };
}

function hostMem(host: HostSnapshot) {
  const m = host.mem;
  return {
    hostTotal: m?.total ?? 0,
    hostFree: m?.free ?? 0,
    hostInactive: m?.inactive ?? 0,
    hostWired: m?.wired ?? 0,
    hostCompressed: m?.compressed ?? 0,
  };
}

// Pure: assemble a Sample from a reading, the rates, the model list and the
// host snapshot.
export function buildSample(
  cur: Reading,
  rates: Rates,
  models: ModelInfo[],
  host: HostSnapshot = EMPTY_HOST,
): Sample {
  const g = cur.metrics.gauges;
  const weights = models
    .filter((m) => m.loaded)
    .reduce((s, m) => s + m.bytesResident, 0);
  return {
    t: cur.t,
    engineUp: true,
    epoch: rates.epoch,
    windowMs: rates.windowMs,
    decodeTps: rates.decodeTps,
    prefillTps: rates.prefillTps,
    requestsRunning: g.requestsRunning,
    requestsWaiting: g.requestsWaiting,
    cacheHitPct: rates.cacheHitPct,
    cacheTokenPct: rates.cacheTokenPct,
    gpuPct: g.gpuPct,
    enginePid: host.pid,
    mem: {
      ...hostMem(host),
      procFootprint: host.proc?.footprint ?? g.memoryBytes,
      procRss: host.proc?.rss ?? 0,
      weights,
      hotCacheEst: Math.max(0, g.mlxActiveBytes - weights),
      mlxActive: g.mlxActiveBytes,
      mlxPool: g.mlxCacheBytes,
    },
    disk: host.disk,
    models,
  };
}

// The engine did not answer. Host memory and the disk tier are still real.
export function downSample(
  t: number,
  epoch: number,
  host: HostSnapshot = EMPTY_HOST,
): Sample {
  return {
    t,
    engineUp: false,
    epoch,
    windowMs: null,
    decodeTps: null,
    prefillTps: null,
    requestsRunning: 0,
    requestsWaiting: 0,
    cacheHitPct: null,
    cacheTokenPct: null,
    gpuPct: 0,
    enginePid: null,
    mem: {
      ...hostMem(host),
      procFootprint: 0,
      procRss: 0,
      weights: 0,
      hotCacheEst: 0,
      mlxActive: 0,
      mlxPool: 0,
    },
    disk: host.disk,
    models: [],
  };
}

export async function readEngine(engine: Engine): Promise<Reading | null> {
  try {
    const metrics = await engine.metrics();
    return { t: Date.now(), metrics };
  } catch {
    return null;
  }
}

// One sample with rates measured over `windowMs`: two metrics reads, one
// models read, the host probes once. This is the --once path; the 1 Hz
// sampler keeps the previous reading between ticks instead of sleeping.
export async function takeSample(
  engine: Engine,
  windowMs: number,
  probes: HostProbes,
): Promise<Sample> {
  const local = isLocalUrl(engine.url);
  const pid = local ? probes.findPid(engine.processNames()) : null;
  const host: HostSnapshot = {
    mem: probes.hostMemory(),
    pid,
    proc: pid === null ? null : probes.processMemory(pid),
    disk: local ? await cacheDirSizes(engine.cacheDirs()) : [],
  };
  const first = await readEngine(engine);
  if (!first) return downSample(Date.now(), 0, host);
  await Bun.sleep(windowMs);
  const [second, models] = await Promise.all([
    readEngine(engine),
    engine.models().catch(() => [] as ModelInfo[]),
  ]);
  if (!second) return downSample(Date.now(), 0, host);
  return buildSample(second, computeRates(first, second, 0), models, host);
}
