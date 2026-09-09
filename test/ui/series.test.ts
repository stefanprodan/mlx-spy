// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DASH } from "../../src/ui/format.ts";
import { whole } from "../../src/ui/monitor/range.ts";
import { appendLive, chipValue } from "../../src/ui/monitor/series.ts";
import { sample, series, startedAt } from "./helpers.ts";

describe("series", () => {
  test("appendLive adds the sample to every column without touching the input", () => {
    const before = series(2);
    const s = sample({
      t: startedAt + 2000,
      decodeTps: 42,
      generatedTokens: 7,
      disk: [
        { model: "a", bytes: 5, path: "" },
        { model: "b", bytes: 6, path: "" },
      ] as never,
    });
    const after = appendLive(before, s);
    expect(before.t.length).toBe(2);
    expect(after.t).toEqual([startedAt, startedAt + 1000, startedAt + 2000]);
    expect(after.decodeTps.at(-1)).toBe(42);
    expect(after.generationTokens.at(-1)).toBe(7);
    expect(after.diskBytes.at(-1)).toBe(11);
    expect(after.engineUp.at(-1)).toBe(1);
    for (const k of Object.keys(after) as (keyof typeof after)[]) {
      expect(after[k].length).toBe(3);
    }
  });

  test("appendLive wires every column to its sample field", () => {
    const s = sample({
      t: startedAt + 2000,
      engineUp: false,
      epoch: 7,
      decodeTps: 1,
      prefillTps: 2,
      requestsRunning: 3,
      requestsWaiting: 4,
      cacheHitPct: 5,
      cacheTokenPct: 6,
      gpuPct: 8,
      ttftMs: 9,
      ttftN: 10,
      generatedTokens: 11,
      requestsTotal: 12,
      promptTokens: 13,
      cachedPromptTokens: 14,
      requestsCancelled: 15,
      mem: {
        procFootprint: 16,
        weights: 17,
        hotCacheEst: 18,
        mlxActive: 19,
        mlxPool: 20,
        hostTotal: 21,
        hostFree: 22,
        hostInactive: 23,
        hostWired: 24,
        hostCompressed: 25,
        procRss: 26,
      },
      disk: [{ model: "a", bytes: 27, path: "" }] as never,
    });
    const after = appendLive(series(1), s);
    const last = Object.fromEntries(
      Object.entries(after).map(([k, v]) => [k, v.at(-1)]),
    );
    expect(last).toEqual({
      t: s.t,
      engineUp: 0,
      epoch: 7,
      decodeTps: 1,
      prefillTps: 2,
      requestsRunning: 3,
      requestsWaiting: 4,
      cacheHitPct: 5,
      cacheTokenPct: 6,
      gpuPct: 8,
      procFootprint: 16,
      weights: 17,
      hotCacheEst: 18,
      mlxActive: 19,
      mlxPool: 20,
      hostTotal: 21,
      hostFree: 22,
      hostInactive: 23,
      hostWired: 24,
      hostCompressed: 25,
      procRss: 26,
      diskBytes: 27,
      ttftMs: 9,
      ttftN: 10,
      generationTokens: 11,
      requestsTotal: 12,
      promptTokens: 13,
      cachedPromptTokens: 14,
      requestsCancelled: 15,
    });
  });

  test("appendLive slides the window past one hour", () => {
    const before = series(3);
    const s = sample({ t: startedAt + 3_600_000 + 1000 });
    const after = appendLive(before, s);
    // the first point is older than an hour before the new sample; the
    // second is exactly an hour old and stays
    expect(after.t).toEqual([startedAt + 1000, startedAt + 2000, s.t]);
    expect(after.decodeTps.length).toBe(3);
  });

  test("chipValue shows the point, or the last non-zero one dimmed", () => {
    expect(chipValue([10, 20, 0], null, whole)).toEqual({
      text: "20",
      idle: true,
      none: false,
    });
    expect(chipValue([10, 20, 30], null, whole)).toEqual({
      text: "30",
      idle: false,
      none: false,
    });
    expect(chipValue([10, 20, 30], 0, whole)).toEqual({
      text: "10",
      idle: false,
      none: false,
    });
    expect(chipValue([0, null], null, whole)).toEqual({
      text: DASH,
      idle: true,
      none: true,
    });
    expect(chipValue([], null, whole)).toEqual({
      text: DASH,
      idle: false,
      none: true,
    });
  });
});
