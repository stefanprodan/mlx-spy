// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { LastRequest } from "../../src/requests.ts";
import type { Sample } from "../../src/sample.ts";
import { initialMemory, requestBar } from "../../src/ui/monitor/request.ts";

const startedAt = new Date(2026, 8, 9, 10, 0, 0).getTime();
const stamp = (time: number) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(time);

const lastRequest = (overrides: Partial<LastRequest> = {}): LastRequest => ({
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

const sample = (overrides: Partial<Sample> = {}): Sample => ({
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

describe("request bar", () => {
  test("idle", () => {
    const result = requestBar(initialMemory, sample());
    expect(result.bar).toMatchObject({
      state: "idle",
      stateClass: "cur-state",
      when: "",
      tokens: "",
      barClass: "cur-bar",
      prefillWidth: 0,
      decodeWidth: 0,
      prefillText: "",
      decodeText: "",
      totalText: "No inflight requests",
      waitingText: "",
    });
  });

  test("in flight prefilling", () => {
    const result = requestBar(
      initialMemory,
      sample({
        request: { startedAt, prefillMs: 1000, decodeMs: 0 },
        requestsRunning: 1,
        requestsWaiting: 2,
        requestsPrefilling: 1,
        inflightTokens: 15,
        prefillTps: 128,
      }),
    );
    expect(result.memory).toEqual({
      startedAt,
      prefillTps: 128,
      decodeTps: null,
    });
    expect(result.bar).toMatchObject({
      state: "in flight",
      stateClass: "cur-state on",
      when: stamp(startedAt),
      tokens: "15 tok generating",
      barClass: "cur-bar running prefilling",
      prefillWidth: 100,
      decodeWidth: 0,
      prefillText: "prefill 1s · 128 tok/s",
      decodeText: "",
      totalText: "2s · prefilling",
      waitingText: "2 waiting",
    });
  });

  test("in flight decoding keeps both phase rates", () => {
    const prefilling = requestBar(
      initialMemory,
      sample({
        request: { startedAt, prefillMs: 1000, decodeMs: 0 },
        requestsRunning: 1,
        requestsPrefilling: 1,
        prefillTps: 128,
      }),
    );
    const result = requestBar(
      prefilling.memory,
      sample({
        t: startedAt + 3200,
        request: { startedAt, prefillMs: 1000, decodeMs: 2000 },
        requestsRunning: 2,
        inflightTokens: 64,
        decodeTps: 32,
      }),
    );
    expect(result.memory).toEqual({
      startedAt,
      prefillTps: 128,
      decodeTps: 32,
    });
    expect(result.bar.state).toBe("2 in flight");
    expect(result.bar.barClass).toBe("cur-bar running");
    expect(result.bar.prefillWidth).toBeCloseTo(100 / 3);
    expect(result.bar.decodeWidth).toBeCloseTo(200 / 3);
    expect(result.bar.prefillText).toBe("prefill 1s · 128 tok/s");
    expect(result.bar.decodeText).toBe("decode 2s · 32 tok/s");
    expect(result.bar.totalText).toBe("3s · decoding");
  });

  test("finished request", () => {
    const last = lastRequest();
    const result = requestBar(initialMemory, sample({ lastRequest: last }));
    expect(result.bar).toMatchObject({
      state: "last request",
      stateClass: "cur-state",
      when: stamp(startedAt),
      tokens: "80 tok generated",
      barClass: "cur-bar",
      prefillWidth: 20,
      decodeWidth: 80,
      prefillText: "prefill 1s · 1.0K tok",
      cachedText: " · 75% cached",
      prefillRateText: " · 250 tok/s",
      decodeText: "decode 4s · 20 tok/s",
      totalText: "6s · done",
    });
  });

  test("finished cancellations", () => {
    const last = lastRequest({
      startedAt: null,
      count: 2,
      cancelled: true,
      generated: 12,
      promptTokens: 0,
      prefillTokens: 0,
      prefillMs: 0,
      decodeMs: 1200,
    });
    const result = requestBar(initialMemory, sample({ lastRequest: last }));
    expect(result.bar).toMatchObject({
      state: "last 2 requests",
      when: stamp(last.finishedAt),
      tokens: "12 tok generated",
      barClass: "cur-bar cancelled",
      prefillWidth: 0,
      decodeWidth: 100,
      prefillText: "",
      cachedText: "",
      prefillRateText: "",
      decodeText: "decode 1s · 10 tok/s",
      totalText: "1s · cancelled",
    });
  });

  test("engine down ignores stale in-flight gauges", () => {
    const last = lastRequest();
    const result = requestBar(
      initialMemory,
      sample({
        engineUp: false,
        request: { startedAt: startedAt + 10_000, prefillMs: 500, decodeMs: 0 },
        lastRequest: last,
        requestsRunning: 1,
        requestsPrefilling: 1,
      }),
    );
    expect(result.bar.state).toBe("last request");
    expect(result.bar.when).toBe(stamp(startedAt));
    expect(result.bar.barClass).toBe("cur-bar");
    expect(result.bar.totalText).toBe("6s · done");
  });
});
