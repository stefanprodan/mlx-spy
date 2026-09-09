// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  count,
  DASH,
  diskSize,
  gb,
  group,
  num,
  secs,
  tps,
  when,
} from "../../src/ui/format.ts";

describe("format", () => {
  test("gb is binary and dashes a missing value", () => {
    expect(gb(96 * 2 ** 30)).toBe("96.0");
    expect(gb(96 * 2 ** 30, 0)).toBe("96");
    expect(gb(null)).toBe(DASH);
    expect(gb(undefined)).toBe(DASH);
  });

  test("diskSize is decimal, as Finder labels it", () => {
    expect(diskSize(994_662_584_320)).toBe("995 GB");
    expect(diskSize(2_000_000_000_000)).toBe("2.0 TB");
  });

  test("num and count", () => {
    expect(num(null)).toBe(DASH);
    expect(num(12.345, 1)).toBe("12.3");
    expect(count(999)).toBe("999");
    expect(count(12_345)).toBe("12.3K");
    expect(count(1_234_567)).toBe("1.23M");
  });

  test("secs and tps", () => {
    expect(secs(4_200)).toBe("4.2 s");
    expect(secs(12_400)).toBe("12 s");
    expect(secs(65_000)).toBe("1 min 5 s");
    expect(tps(1200, 10_000)).toBe("120 tok/s");
    expect(tps(1200, 0)).toBe("-");
  });

  test("when and group against a fixed clock", () => {
    const now = new Date(2026, 8, 9, 15, 30).getTime(); // a Wednesday
    const hour = 3_600_000;
    const day = 24 * hour;
    const clock = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(when(now - 30_000, now)).toBe("now");
    expect(when(now - 2 * hour, now)).toBe(clock.format(now - 2 * hour));
    expect(when(now - 2 * day, now)).toBe(
      new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
        now - 2 * day,
      ),
    );
    expect(when(now - 10 * day, now)).toBe(
      new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
      }).format(now - 10 * day),
    );
    expect(group(now - 2 * hour, now)).toBe("Today");
    expect(group(now - day, now)).toBe("Yesterday");
    expect(group(now - 3 * day, now)).toBe("This week");
    expect(group(now - 10 * day, now)).toBe("Earlier");
  });
});
