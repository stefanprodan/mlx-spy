// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Builders for the client tests: a sample, a last request and a series,
// every field set, overridable.

import type { Series } from "../../src/history.ts";
import type { LastRequest } from "../../src/requests.ts";
import type { Sample } from "../../src/sample.ts";

export const startedAt = new Date(2026, 8, 9, 10, 0, 0).getTime();
export const stamp = (time: number) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(time);

export const lastRequest = (
  overrides: Partial<LastRequest> = {},
): LastRequest => ({
  startedAt,
  finishedAt: startedAt + 5500,
  count: 1,
  cancelled: false,
  generated: 80,
  promptTokens: 1000,
  prefillTokens: 250,
  prefillMs: 1000,
  decodeMs: 4000,
  ttftMs: 1200,
  model: "org/model",
  ...overrides,
});

export const sample = (overrides: Partial<Sample> = {}): Sample => ({
  t: startedAt + 1500,
  engineUp: true,
  epoch: 0,
  windowMs: 1000,
  decodeTps: 0,
  prefillTps: 0,
  requestsRunning: 0,
  requestsWaiting: 0,
  requestsPrefilling: 0,
  prefillTokensLive: 0,
  inflightTokens: 0,
  phaseSince: null,
  request: null,
  lastRequest: null,
  cacheHitPct: null,
  cacheTokenPct: null,
  ttftMs: null,
  ttftN: 0,
  gpuPct: 0,
  generatedTokens: 0,
  promptTokens: 0,
  cachedPromptTokens: 0,
  requestsTotal: 0,
  requestsCancelled: 0,
  enginePid: null,
  engineStartedAt: null,
  engineCpuPct: null,
  mem: {
    hostTotal: 0,
    hostFree: 0,
    hostInactive: 0,
    hostWired: 0,
    hostCompressed: 0,
    procFootprint: 0,
    procRss: 0,
    weights: 0,
    hotCacheEst: 0,
    mlxActive: 0,
    mlxPool: 0,
  },
  disk: [],
  models: [],
  ...overrides,
});

// a raw series of n one-second points, every column zero or null unless
// overridden
export const series = (n: number, over: Partial<Series> = {}): Series => {
  const zeros = () => Array.from({ length: n }, () => 0);
  const nulls = () => Array.from({ length: n }, () => null);
  return {
    t: Array.from({ length: n }, (_, i) => startedAt + i * 1000),
    engineUp: Array.from({ length: n }, () => 1 as const),
    epoch: zeros(),
    decodeTps: nulls(),
    prefillTps: nulls(),
    requestsRunning: zeros(),
    requestsWaiting: zeros(),
    cacheHitPct: nulls(),
    cacheTokenPct: nulls(),
    gpuPct: zeros(),
    procFootprint: zeros(),
    weights: zeros(),
    hotCacheEst: zeros(),
    mlxActive: zeros(),
    mlxPool: zeros(),
    hostTotal: zeros(),
    hostFree: zeros(),
    hostInactive: zeros(),
    hostWired: zeros(),
    hostCompressed: zeros(),
    procRss: zeros(),
    diskBytes: zeros(),
    ttftMs: nulls(),
    ttftN: zeros(),
    generationTokens: zeros(),
    requestsTotal: zeros(),
    promptTokens: zeros(),
    cachedPromptTokens: zeros(),
    requestsCancelled: zeros(),
    ...over,
  };
};
