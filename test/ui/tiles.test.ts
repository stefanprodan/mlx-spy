// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DASH } from "../../src/ui/format.ts";
import {
  apply,
  disconnect,
  initialTiles,
  PLACEHOLDER,
  seed,
  type Tile,
  tiles,
} from "../../src/ui/monitor/tiles.ts";
import { lastRequest, sample, series, stamp } from "./helpers.ts";

const GB = 2 ** 30;
const gbOf = (b: number) => (b / GB).toFixed(0);
const byKey = (list: Tile[], key: string) => list.find((t) => t.key === key)!;

describe("tile memory", () => {
  test("seed fills what is empty from the history, a live value wins", () => {
    const s = series(4, {
      decodeTps: [30, 0, null, 0],
      prefillTps: [null, 200, 0, 0],
      cacheHitPct: [null, 90, null, null],
      cacheTokenPct: [null, 55, null, null],
      promptTokens: [100, 100, 700, 700],
      cachedPromptTokens: [10, 10, 500, 500],
    });
    const m = seed(initialTiles, s);
    expect(m.lastDecode).toBe(30);
    expect(m.lastPrefill).toBe(200);
    expect(m.lastCacheHit).toBe(90);
    expect(m.lastCacheTok).toBe(55);
    expect(m.lastReq).toEqual({ prompt: 600, cached: 490 });
    const kept = seed({ ...initialTiles, lastDecode: 99 }, s);
    expect(kept.lastDecode).toBe(99);
  });

  test("seed ignores a prompt step across an engine restart", () => {
    const s = series(2, {
      epoch: [1, 2],
      promptTokens: [100, 700],
      cachedPromptTokens: [0, 0],
    });
    expect(seed(initialTiles, s).lastReq).toBeNull();
  });

  test("apply keeps per-request values between samples", () => {
    let m = apply(initialTiles, sample({ decodeTps: 40, cacheTokenPct: 80 }));
    expect(m.lastDecode).toBe(40);
    expect(m.lastCacheTok).toBe(80);
    m = apply(m, sample({ decodeTps: 0, cacheTokenPct: null }));
    expect(m.lastDecode).toBe(40);
    expect(m.lastCacheTok).toBe(80);
  });

  test("apply derives the last request's prompt from consecutive samples", () => {
    let m = apply(
      initialTiles,
      sample({ epoch: 3, promptTokens: 1000, cachedPromptTokens: 100 }),
    );
    expect(m.lastReq).toBeNull();
    m = apply(
      m,
      sample({ epoch: 3, promptTokens: 1600, cachedPromptTokens: 550 }),
    );
    expect(m.lastReq).toEqual({ prompt: 600, cached: 450 });
    // a new epoch: the counters restarted, no request is derived
    m = apply(m, sample({ epoch: 4, promptTokens: 50, cachedPromptTokens: 0 }));
    expect(m.lastReq).toEqual({ prompt: 600, cached: 450 });
    // a down sample forgets the counters
    m = apply(m, sample({ engineUp: false }));
    expect(m.prevTok).toBeNull();
  });

  test("disconnect forgets the previous counters only", () => {
    const m = apply(initialTiles, sample({ decodeTps: 40, promptTokens: 5 }));
    const d = disconnect(m);
    expect(d.prevTok).toBeNull();
    expect(d.lastDecode).toBe(40);
  });
});

const limits = { hotBytes: 8 * GB, diskBytes: 20 * GB };

describe("tiles", () => {
  test("the placeholder has the eight tiles with their bars", () => {
    expect(PLACEHOLDER.map((t) => t.key)).toEqual([
      "requests",
      "generated",
      "prefill",
      "decode",
      "eff",
      "mem",
      "cache",
      "ssd",
    ]);
    expect(byKey(PLACEHOLDER, "cache").bar?.off).toBe(true);
    expect(byKey(PLACEHOLDER, "mem").bar?.off).toBe(false);
  });

  test("requests and generated come from the loaded range", () => {
    const ser = series(3, {
      requestsTotal: [10, 12, 15],
      requestsCancelled: [0, 1, 1],
      generationTokens: [0, 400, 1000],
      promptTokens: [0, 500, 1000],
      ttftMs: [null, 800, 400],
      ttftN: [0, 1, 1],
    });
    const list = tiles(initialTiles, sample(), ser, null, false);
    const req = byKey(list, "requests");
    expect(req.value).toBe("5");
    expect(req.sub).toEqual([{ warn: "1 cancelled" }, " · ", "TTFT avg 0.6 s"]);
    const gen = byKey(list, "generated");
    expect(gen.value).toBe("1.0K");
    expect(gen.sub).toEqual(["50% of 2.0K total"]);
  });

  test("prefill and decode show the last speeds, else the last request time", () => {
    const s = sample({ lastRequest: lastRequest() });
    const idle = tiles(initialTiles, s, null, null, false);
    expect(byKey(idle, "decode").value).toBe(DASH);
    expect(byKey(idle, "decode").none).toBe(true);
    expect(byKey(idle, "decode").sub).toEqual([
      `last at ${stamp(lastRequest().finishedAt)}`,
    ]);
    const m = apply(initialTiles, sample({ decodeTps: 41.6, prefillTps: 300 }));
    const ser = series(2, { decodeTps: [40, 44], prefillTps: [300, null] });
    const live = tiles(m, s, ser, null, false);
    expect(byKey(live, "decode").value).toBe("42");
    expect(byKey(live, "decode").sub).toEqual(["avg 42 · peak 44"]);
    expect(byKey(live, "prefill").value).toBe("300");
  });

  test("memory and cache efficiency", () => {
    const s = sample({
      mem: {
        ...sample().mem,
        procFootprint: 20 * GB,
        hostTotal: 128 * GB,
        hostFree: 40 * GB,
        hostInactive: 32 * GB,
      },
    });
    let m = apply(
      initialTiles,
      sample({ cacheTokenPct: 84, promptTokens: 100, cachedPromptTokens: 0 }),
    );
    m = apply(m, sample({ promptTokens: 896, cachedPromptTokens: 672 }));
    const list = tiles(m, s, null, null, false);
    const mem = byKey(list, "mem");
    expect(mem.value).toBe("20");
    expect(mem.bar).toEqual({ pct: 15.625, level: "", off: false });
    expect(mem.sub).toEqual(["72 GB free of 128"]);
    const eff = byKey(list, "eff");
    expect(eff.value).toBe("84");
    expect(eff.bar).toEqual({ pct: 84, level: "", off: false });
    expect(eff.sub).toEqual(["672 of 796 prompt tokens"]);
  });

  test("memory bar levels", () => {
    const at = (pct: number) =>
      byKey(
        tiles(
          initialTiles,
          sample({
            mem: {
              ...sample().mem,
              procFootprint: pct * GB,
              hostTotal: 100 * GB,
            },
          }),
          null,
          null,
          false,
        ),
        "mem",
      ).bar?.level;
    expect(at(50)).toBe("");
    expect(at(80)).toBe("warn");
    expect(at(95)).toBe("crit");
  });

  test("RAM cache scales its budget with the resident models", () => {
    const model = (id: string) => ({
      id,
      loaded: true,
      state: "ready",
      bytesResident: GB,
      bytesOnDisk: GB,
      contextLength: null,
      capabilities: [],
    });
    const s = sample({
      models: [model("a/b"), model("c/d")],
      mem: { ...sample().mem, hotCacheEst: 4 * GB },
    });
    const list = tiles(initialTiles, s, null, limits, true);
    const cache = byKey(list, "cache");
    expect(cache.value).toBe("4");
    expect(cache.bar).toEqual({ pct: 25, level: "", off: false });
    expect(cache.sub).toEqual(["of 16 GB for 2 models"]);
    const hit = tiles(
      apply(initialTiles, sample({ cacheHitPct: 100 })),
      s,
      null,
      limits,
      true,
    );
    expect(byKey(hit, "cache").sub).toEqual(["100% of lookups hit"]);
    const down = byKey(
      tiles(initialTiles, sample({ engineUp: false }), null, limits, true),
      "cache",
    );
    expect(down.value).toBe(DASH);
    expect(down.bar?.off).toBe(true);
  });

  test("SSD cache is a local fact", () => {
    const disk = [{ model: "a", bytes: 10 * GB, path: "" }] as never;
    const remote = byKey(
      tiles(initialTiles, sample({ disk }), null, limits, false),
      "ssd",
    );
    expect(remote.value).toBe(DASH);
    expect(remote.bar?.off).toBe(true);
    expect(remote.sub).toEqual([""]);
    const local = byKey(
      tiles(initialTiles, sample({ disk }), null, limits, true),
      "ssd",
    );
    expect(local.value).toBe("10");
    expect(local.bar).toEqual({ pct: 50, level: "", off: false });
    expect(local.sub).toEqual(["of 20 GB per model"]);
    const noLimit = byKey(
      tiles(initialTiles, sample({ disk }), null, null, true),
      "ssd",
    );
    expect(noLimit.sub).toEqual(["1 model dir on disk"]);
  });
});

describe("tiles on a recorded engine reading", () => {
  // the sampler's own path: recorded /metrics.json and /v1/models bodies
  // through buildSample, then the tiles, so the fields the tiles read are
  // the ones the sampler writes
  test("the memory and weights tiles read the sampler's fields", async () => {
    const { parseMetrics, parseModels } = await import(
      "../../src/engine/mlxserve.ts"
    );
    const { buildSample, computeRates } = await import("../../src/sample.ts");
    const metrics = await Bun.file("test/fixtures/metrics.json").json();
    const models = parseModels(
      await Bun.file("test/fixtures/models.json").json(),
    );
    const reading = (t: number) => ({ t, metrics: parseMetrics(metrics) });
    const cur = reading(5000);
    const s = buildSample(cur, computeRates(reading(4000), cur, 0), models);
    const list = tiles(
      initialTiles,
      s,
      null,
      { hotBytes: 8 * GB, diskBytes: 0 },
      false,
    );
    expect(byKey(list, "mem").value).toBe(gbOf(s.mem.procFootprint));
    expect(byKey(list, "cache").value).toBe(gbOf(s.mem.hotCacheEst));
    expect(byKey(list, "cache").sub).toEqual([
      `of ${gbOf(8 * GB * s.models.filter((m) => m.loaded).length)} GB for ${
        s.models.filter((m) => m.loaded).length
      } models`,
    ]);
    expect(byKey(list, "ssd").value).toBe(DASH);
  });

  test("SSD cache branches", () => {
    const disk = [
      { model: "a", bytes: 10 * GB, path: "" },
      { model: "b", bytes: 5 * GB, path: "" },
    ] as never;
    const two = byKey(
      tiles(initialTiles, sample({ disk }), null, limits, true),
      "ssd",
    );
    expect(two.value).toBe("15");
    expect(two.bar).toEqual({ pct: 37.5, level: "", off: false });
    expect(two.sub).toEqual(["of 40 GB for 2 model dirs"]);
    const dirs = byKey(
      tiles(initialTiles, sample({ disk }), null, null, true),
      "ssd",
    );
    expect(dirs.sub).toEqual(["2 model dirs on disk"]);
    const empty = byKey(tiles(initialTiles, sample(), null, null, true), "ssd");
    expect(empty.value).toBe("0");
    expect(empty.sub).toEqual([""]);
    expect(empty.bar?.off).toBe(true);
    const over = byKey(
      tiles(
        initialTiles,
        sample({ disk: [{ model: "a", bytes: 50 * GB, path: "" }] as never }),
        null,
        limits,
        true,
      ),
      "ssd",
    );
    expect(over.bar).toEqual({ pct: 100, level: "crit", off: false });
  });
});
