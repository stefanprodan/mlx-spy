// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Totals and means over the loaded range of the history series. Pure;
// tested in test/ui/range.test.ts.

import type { Series } from "../../history.ts";
import { DASH } from "../format.ts";

// whole tok/s; anything under one that is not zero reads as 1
export const whole = (v: number | null | undefined) =>
  v == null ? DASH : v > 0 ? `${Math.max(1, Math.round(v))}` : "0";

// How much a lifetime counter grew over the loaded range: the sum of its
// steps between consecutive points, within one engine run (a restart zeroes
// the counters) and only while the engine answered (a down sample holds 0).
// A step from 0 counts: it is the first request after an engine restart.
export function rangeTotal(
  series: Series | null,
  k:
    | "generationTokens"
    | "promptTokens"
    | "requestsTotal"
    | "requestsCancelled",
): number {
  if (!series) return 0;
  const v = series[k];
  let sum = 0;
  for (let i = 1; i < v.length; i++) {
    if (
      series.engineUp[i] === 1 &&
      series.engineUp[i - 1] === 1 &&
      series.epoch[i] === series.epoch[i - 1] &&
      v[i] > v[i - 1]
    ) {
      sum += v[i] - v[i - 1];
    }
  }
  return sum;
}

// "avg 30 · peak 46": the mean and highest of a rate over the loaded range,
// counting only the seconds the phase was active, so idle time does not
// drag the average down
export function inView(
  series: Series | null,
  k: "decodeTps" | "prefillTps",
): string {
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (const v of series?.[k] ?? []) {
    if (v == null || v <= 0) continue;
    if (v > peak) peak = v;
    sum += v;
    n++;
  }
  return n ? `avg ${whole(sum / n)} · peak ${whole(peak)}` : "";
}

// the mean TTFT over the loaded range, each point weighted by the requests
// its own mean covers; null when no request finished in view
export function inViewMean(series: Series | null, k: "ttftMs"): number | null {
  if (!series) return null;
  let sum = 0;
  let n = 0;
  const v = series[k];
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    const w = series.ttftN[i];
    if (x == null || !(w > 0)) continue;
    sum += x * w;
    n += w;
  }
  return n ? sum / n : null;
}
