// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The raw 1h series and the live samples that extend it. Pure; tested in
// test/ui/series.test.ts.

import type { Series } from "../../history.ts";
import type { Sample } from "../../sample.ts";
import { DASH } from "../format.ts";

const HOUR = 3_600_000;

// Live samples extend the raw 1h series; the oldest second drops off once
// the hour is full so the window slides. Returns a new record, the input
// is not touched.
export function appendLive(series: Series, s: Sample): Series {
  const next: Series = {
    t: [...series.t, s.t],
    engineUp: [...series.engineUp, s.engineUp ? 1 : 0],
    epoch: [...series.epoch, s.epoch],
    decodeTps: [...series.decodeTps, s.decodeTps],
    prefillTps: [...series.prefillTps, s.prefillTps],
    requestsRunning: [...series.requestsRunning, s.requestsRunning],
    requestsWaiting: [...series.requestsWaiting, s.requestsWaiting],
    cacheHitPct: [...series.cacheHitPct, s.cacheHitPct],
    cacheTokenPct: [...series.cacheTokenPct, s.cacheTokenPct],
    gpuPct: [...series.gpuPct, s.gpuPct],
    procFootprint: [...series.procFootprint, s.mem.procFootprint],
    weights: [...series.weights, s.mem.weights],
    hotCacheEst: [...series.hotCacheEst, s.mem.hotCacheEst],
    mlxActive: [...series.mlxActive, s.mem.mlxActive],
    mlxPool: [...series.mlxPool, s.mem.mlxPool],
    hostTotal: [...series.hostTotal, s.mem.hostTotal],
    hostFree: [...series.hostFree, s.mem.hostFree],
    hostInactive: [...series.hostInactive, s.mem.hostInactive],
    hostWired: [...series.hostWired, s.mem.hostWired],
    hostCompressed: [...series.hostCompressed, s.mem.hostCompressed],
    procRss: [...series.procRss, s.mem.procRss],
    diskBytes: [...series.diskBytes, s.disk.reduce((n, d) => n + d.bytes, 0)],
    ttftMs: [...series.ttftMs, s.ttftMs],
    ttftN: [...series.ttftN, s.ttftN],
    generationTokens: [...series.generationTokens, s.generatedTokens],
    requestsTotal: [...series.requestsTotal, s.requestsTotal],
    promptTokens: [...series.promptTokens, s.promptTokens],
    cachedPromptTokens: [...series.cachedPromptTokens, s.cachedPromptTokens],
    requestsCancelled: [...series.requestsCancelled, s.requestsCancelled],
  };
  const cutoff = s.t - HOUR;
  let drop = 0;
  while (drop < next.t.length && next.t[drop] < cutoff) drop++;
  if (drop > 0) {
    for (const k of Object.keys(next) as (keyof Series)[]) {
      (next[k] as unknown[]).splice(0, drop);
    }
  }
  return next;
}

// The value a chart chip shows. idx null: the latest point, or, when
// nothing is running, the last non-zero value dimmed, so the chip is not a
// permanent 0 between requests.
export function chipValue(
  arr: (number | null)[],
  idx: number | null,
  fmt: (v: number | null) => string,
): { text: string; idle: boolean; none: boolean } {
  let at = idx == null ? arr.length - 1 : idx;
  let idle = false;
  if (idx == null && at >= 0 && !((arr[at] ?? 0) > 0)) {
    idle = true;
    while (at >= 0 && !((arr[at] ?? 0) > 0)) at--;
  }
  const text = fmt(at >= 0 ? (arr[at] ?? null) : null);
  return { text, idle, none: text === DASH };
}
