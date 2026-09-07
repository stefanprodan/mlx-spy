import { describe, expect, test } from "bun:test";
import {
  buildChatBody,
  chatEvents,
  limitsFromArgs,
  parseLaunchdArgs,
  parseMetrics,
  parseModels,
  parseSize,
  parseSse,
} from "../src/engine/mlxserve.ts";
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

describe("launch configuration", () => {
  const GiB = 1024 ** 3;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ddalcu.mlx-serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/mlx-serve</string>
    <string>--serve</string>
    <string>--model-dir</string>
    <string>/Users/x/models &amp; more</string>
    <string>--prefix-cache-mem</string>
    <string>16GB</string>
    <string>--prefix-cache-disk</string>
    <string>50GB</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/bin</string></dict>
</dict>
</plist>`;

  test("parseSize follows the engine's grammar", () => {
    expect(parseSize("16GB")).toBe(16 * GiB);
    expect(parseSize("512mb")).toBe(512 * 1024 ** 2);
    expect(parseSize("8KB")).toBe(8192);
    expect(parseSize("4096")).toBe(4096);
    expect(parseSize("off")).toBe(0);
    expect(parseSize("0")).toBe(0);
    expect(parseSize("16 GB")).toBe(16 * GiB);
    expect(parseSize("lots")).toBeNull();
    expect(parseSize("GB")).toBeNull();
  });

  test("parseLaunchdArgs reads only ProgramArguments", () => {
    const args = parseLaunchdArgs(plist);
    expect(args[0]).toBe("/opt/homebrew/bin/mlx-serve");
    expect(args).toContain("/Users/x/models & more");
    expect(args).not.toContain("/usr/bin");
    expect(parseLaunchdArgs("<plist/>")).toEqual([]);
  });

  test("limitsFromArgs takes the flags, with the engine's defaults", () => {
    expect(limitsFromArgs(parseLaunchdArgs(plist))).toEqual({
      hotBytes: 16 * GiB,
      diskBytes: 50 * GiB,
    });
    expect(limitsFromArgs(["mlx-serve", "--serve"])).toEqual({
      hotBytes: 2 * GiB,
      diskBytes: 0,
    });
    expect(limitsFromArgs(["--prefix-cache-mem=4GB"]).hotBytes).toBe(4 * GiB);
    expect(limitsFromArgs(["--prefix-cache-disk", "off"]).diskBytes).toBe(0);
    // a malformed value keeps the default rather than poisoning the tile
    expect(limitsFromArgs(["--prefix-cache-mem", "big"]).hotBytes).toBe(
      2 * GiB,
    );
  });
});

describe("chat stream", () => {
  test("parses the recorded SSE fixture across arbitrary read boundaries", async () => {
    const stream = await Bun.file("test/fixtures/chat-stream.sse").text();
    let rest = "";
    const frames: string[] = [];
    let offset = 0;
    let seed = 17;
    while (offset < stream.length) {
      seed = (seed * 48271) % 0x7fffffff;
      const size = (seed % 97) + 1;
      const parsed = parseSse(rest, stream.slice(offset, offset + size));
      frames.push(...parsed.frames);
      rest = parsed.rest;
      offset += size;
    }
    expect(rest).toBe("");
    expect(frames).toHaveLength(83);
    const events = frames.flatMap(chatEvents);
    expect(events.map((event) => event.kind)).toEqual([
      ...Array(79).fill("reasoning"),
      "finish",
      "usage",
    ]);
    expect(
      events
        .filter((event) => event.kind === "reasoning")
        .map((event) => event.text)
        .join(""),
    ).toBe(
      'The user wants me to say hello in exactly five words. Let me think of a greeting that\'s exactly five words long.\n\nOptions:\n- "Hello there, my friend" - 4 words\n- "Hello there, my dear friend" - 5 words ✓\n- "Hi there, how are you" - 5 words ✓\n- "Hello, nice to meet you',
    );
    expect(events.slice(-2)).toEqual([
      { kind: "finish", reason: "length", details: null },
      {
        kind: "usage",
        stats: {
          promptTokens: 46,
          cachedTokens: 0,
          generated: 80,
          prefillMs: 914.624,
          decodeMs: 2318.088,
          tokenizeMs: 2.892,
        },
      },
    ]);
  });

  test("ignores comments and preserves a frame split across reads", () => {
    const first = parseSse("", ': keepalive\r\ndata: {"choices":');
    expect(first.frames).toEqual([]);
    const second = parseSse(first.rest, "[]}\r\n\r\n");
    expect(second.frames).toEqual(['{"choices":[]}']);
    expect(second.rest).toBe("");
  });

  test("maps finish details, errors and fallback usage fields", () => {
    expect(
      chatEvents(
        JSON.stringify({
          choices: [
            {
              delta: {},
              finish_reason: "stop",
              finish_details: { type: "repetition_loop" },
            },
          ],
        }),
      ),
    ).toEqual([{ kind: "finish", reason: "stop", details: "repetition_loop" }]);
    expect(
      chatEvents(JSON.stringify({ error: { message: "out of memory" } })),
    ).toEqual([{ kind: "error", message: "out of memory" }]);
    expect(
      chatEvents(
        JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 3,
            prompt_tokens_details: {},
          },
          timings: { cached_n: 7, prompt_ms: 2, predicted_ms: 4 },
        }),
      ),
    ).toEqual([
      {
        kind: "usage",
        stats: {
          promptTokens: 10,
          cachedTokens: 7,
          generated: 3,
          prefillMs: 2,
          decodeMs: 4,
          tokenizeMs: null,
        },
      },
    ]);
    expect(chatEvents("[DONE]")).toEqual([]);
  });

  test("builds the mlx-serve body with optional settings and reasoning", () => {
    const base = {
      model: "org/model",
      messages: [
        { role: "user" as const, content: "hello" },
        {
          role: "assistant" as const,
          content: "answer",
          reasoning: "thought",
        },
      ],
      thinking: false,
      reasoningEffort: "high",
      temperature: null,
      topP: 0.8,
      maxTokens: null,
    };
    expect(buildChatBody(base)).toEqual({
      model: "org/model",
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "answer",
          reasoning_content: "thought",
        },
      ],
      enable_thinking: false,
      top_p: 0.8,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(
      buildChatBody({
        ...base,
        thinking: true,
        temperature: 0,
        maxTokens: 40,
      }),
    ).toMatchObject({
      reasoning_effort: "high",
      temperature: 0,
      max_tokens: 40,
    });
  });
});
