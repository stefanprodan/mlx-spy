// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DASH } from "../../src/ui/format.ts";
import {
  inView,
  inViewMean,
  rangeTotal,
  whole,
} from "../../src/ui/monitor/range.ts";
import { series } from "./helpers.ts";

describe("range", () => {
  test("whole rounds and floors at one", () => {
    expect(whole(null)).toBe(DASH);
    expect(whole(0)).toBe("0");
    expect(whole(0.2)).toBe("1");
    expect(whole(41.6)).toBe("42");
  });

  test("rangeTotal sums the counter's steps within one engine run", () => {
    const s = series(6, {
      requestsTotal: [10, 12, 15, 0, 2, 2],
      epoch: [1, 1, 1, 2, 2, 2],
    });
    // 2 + 3 in epoch 1; the drop to 0 is a restart; then 2 from zero
    expect(rangeTotal(s, "requestsTotal")).toBe(7);
    expect(rangeTotal(null, "requestsTotal")).toBe(0);
  });

  test("rangeTotal skips steps across a down sample", () => {
    const s = series(4, {
      requestsTotal: [10, 0, 0, 14],
      engineUp: [1, 0, 0, 1],
    });
    expect(rangeTotal(s, "requestsTotal")).toBe(0);
  });

  test("inView averages only the active seconds", () => {
    const s = series(5, { decodeTps: [null, 0, 30, 46, 0] });
    expect(inView(s, "decodeTps")).toBe("avg 38 · peak 46");
    expect(inView(series(3), "decodeTps")).toBe("");
    expect(inView(null, "decodeTps")).toBe("");
  });

  test("inViewMean weights each point by its request count", () => {
    const s = series(4, { ttftMs: [100, null, 400, 50], ttftN: [1, 0, 3, 0] });
    expect(inViewMean(s, "ttftMs")).toBe((100 + 1200) / 4);
    expect(inViewMean(series(2), "ttftMs")).toBeNull();
  });
});
