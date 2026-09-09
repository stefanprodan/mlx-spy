// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { Pull } from "../../src/pulls.ts";
import {
  eta,
  pullDot,
  pullMeta,
  pullPct,
  pullState,
  visiblePulls,
} from "../../src/ui/monitor/pull.ts";

const GB = 2 ** 30;

function pull(over: Partial<Pull> = {}): Pull {
  return {
    id: 1,
    repo: "org/model",
    revision: "abc",
    dir: "/models/org/model",
    status: "running",
    bytesTotal: 16.7 * GB,
    bytesDone: 3.2 * GB,
    filesTotal: 10,
    filesDone: 2,
    file: "model.safetensors",
    error: null,
    createdAt: 0,
    updatedAt: 0,
    finishedAt: null,
    speedBps: 48 * 2 ** 20,
    ...over,
  };
}

describe("pull row copy", () => {
  test("meta: bytes, speed and the time left while running", () => {
    expect(pullMeta(pull())).toBe("3.2 / 16.7 GB · 48 MB/s · 5 min left");
    expect(pullMeta(pull({ speedBps: null }))).toBe("3.2 / 16.7 GB");
    expect(pullMeta(pull({ speedBps: 0 }))).toBe("3.2 / 16.7 GB");
    expect(pullMeta(pull({ status: "queued" }))).toBe("16.7 GB");
    expect(pullMeta(pull({ status: "done", bytesDone: 16.7 * GB }))).toBe(
      "16.7 GB",
    );
    expect(pullMeta(pull({ status: "failed" }))).toBe("3.2 / 16.7 GB");
    expect(pullMeta(pull({ status: "cancelled" }))).toBe("3.2 / 16.7 GB");
  });

  test("eta reads as seconds, minutes or hours", () => {
    expect(eta(0.2)).toBe("1 s");
    expect(eta(42)).toBe("42 s");
    expect(eta(130)).toBe("2 min");
    expect(eta(3600 * 2 + 60 * 5)).toBe("2 h 5 min");
  });

  test("state, dot and share", () => {
    expect(pullState(pull())).toBe("downloading");
    expect(pullState(pull({ status: "queued" }))).toBe("queued");
    expect(pullDot(pull())).toBe("loading");
    expect(pullDot(pull({ status: "failed" }))).toBe("error");
    expect(pullDot(pull({ status: "done" }))).toBe("ready");
    expect(pullDot(pull({ status: "cancelled" }))).toBe("");
    expect(pullPct(pull())).toBeCloseTo(19.16, 1);
    expect(pullPct(pull({ bytesTotal: 0 }))).toBe(0);
    expect(pullPct(pull({ bytesDone: 99 * GB }))).toBe(100);
  });

  test("a finished pull the engine lists is not shown twice", () => {
    const done = pull({ id: 2, status: "done" });
    const other = pull({ id: 3, status: "done", repo: "org/other" });
    const running = pull();
    expect(visiblePulls([running, done, other], [{ id: "org/model" }])).toEqual(
      [running, other],
    );
    expect(visiblePulls([done], [])).toEqual([done]);
  });
});
