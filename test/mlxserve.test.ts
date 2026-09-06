import { describe, expect, test } from "bun:test";
import { parseMetrics, parseModels } from "../src/engine/mlxserve.ts";
import metricsFixture from "./fixtures/metrics.json";
import modelsFixture from "./fixtures/models.json";

describe("parseMetrics", () => {
  const m = parseMetrics(metricsFixture);

  test("normalises counters", () => {
    expect(m.counters.promptTokens).toBe(42781);
    expect(m.counters.prefillTokens).toBe(848);
    expect(m.counters.cachedPromptTokens).toBe(41933);
    expect(m.counters.generationTokens).toBe(26);
    expect(m.counters.requestsSuccess).toBe(1);
    expect(m.counters.cacheQueries).toBe(1);
    expect(m.counters.cacheHits).toBe(1);
  });

  test("converts memory_mb to bytes and keeps allocator gauges", () => {
    expect(m.gauges.memoryBytes).toBe(39439 * 1024 * 1024);
    expect(m.gauges.mlxActiveBytes).toBe(40846363996);
    expect(m.gauges.mlxCacheBytes).toBe(78704656);
    expect(m.gauges.generationTokensLive).toBe(26);
    expect(m.gauges.requestsRunning).toBe(0);
  });

  test("keeps histogram count and sum", () => {
    expect(m.histograms.ttftSeconds.count).toBe(1);
    expect(m.histograms.ttftSeconds.sum).toBeCloseTo(11.2586, 3);
    expect(m.histograms.decodeTimeSeconds.sum).toBeCloseTo(1.2063, 3);
  });

  test("tolerates a missing or malformed body", () => {
    const empty = parseMetrics({});
    expect(empty.counters.promptTokens).toBe(0);
    expect(empty.gauges.memoryBytes).toBe(0);
    expect(empty.histograms.ttftSeconds).toEqual({ count: 0, sum: 0 });
    expect(parseMetrics(null).gauges.gpuPct).toBe(0);
  });
});

describe("parseModels", () => {
  const models = parseModels(modelsFixture);

  test("maps every listed model", () => {
    expect(models.map((m) => m.id)).toEqual([
      "Jundot/Qwen3.8-27B-oQ4e-mtp",
      "stefanprodan/Ornith-1.5-35B-A3B-BigBang-oQ4e-mtp",
      "stefanprodan/Apodex-1.1-mini-oQ4e-mtp",
    ]);
  });

  test("carries residency and sizes", () => {
    const [qwen, , apodex] = models;
    expect(qwen.loaded).toBe(true);
    expect(qwen.state).toBe("ready");
    expect(qwen.bytesResident).toBe(16971681558);
    expect(qwen.contextLength).toBe(133120);
    expect(qwen.capabilities).toContain("tool_use");
    expect(apodex.capabilities).not.toContain("reasoning");
    expect(apodex.loaded).toBe(false);
    expect(apodex.state).toBe("unloaded");
    expect(apodex.bytesResident).toBe(0);
    expect(apodex.bytesOnDisk).toBe(21612875019);
  });

  test("leaves isDefault unknown (mlx-serve does not expose it)", () => {
    for (const m of models) expect(m.isDefault).toBeUndefined();
  });

  test("ignores entries without an id and empty bodies", () => {
    expect(parseModels({ data: [{ loaded: true }] })).toEqual([]);
    expect(parseModels(undefined)).toEqual([]);
  });
});
