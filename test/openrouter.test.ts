// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The OpenRouter adapter over the frames recorded from the live API on
// 2026-09-10 (test/fixtures/openrouter/): the catalog, a tool-calling
// stream, a plain stream with reasoning and a refused request.

import { afterEach, describe, expect, test } from "bun:test";
import {
  buildChatBody,
  Catalog,
  CatalogError,
  errorText,
  OpenRouter,
  parseCatalog,
} from "../src/engine/openrouter.ts";
import type { ChatEvent, ChatRequest } from "../src/engine/types.ts";

const fixture = (name: string) =>
  Bun.file(new URL(`./fixtures/openrouter/${name}`, import.meta.url));
const catalogBody = await fixture("models.json").json();
const toolsStream = await fixture("chat-tools.sse").text();
const plainStream = await fixture("chat-stream.sse").text();
const refused = await fixture("error-429.json").text();

const KEY = "sk-or-v1-test-key-that-must-never-leak";
const FREE = "nvidia/nemotron-3-super-120b-a12b:free";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const request: ChatRequest = {
  model: FREE,
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello", reasoning: "greet back" },
    { role: "user", content: "what time is it?" },
  ],
  thinking: true,
  reasoningEffort: null,
  temperature: 0.7,
  topP: null,
  maxTokens: 300,
  cacheKey: "chat-1",
  tools: [
    {
      name: "get_current_time",
      description: "the clock",
      parameters: { type: "object", properties: {} },
    },
  ],
};

function provider(models = [{ id: FREE, contextLength: 262144 }]) {
  return new OpenRouter({
    key: KEY,
    models: () =>
      models.map((m) => ({
        provider: "openrouter" as const,
        id: m.id,
        name: m.id,
        contextLength: m.contextLength,
        promptPrice: 0,
        completionPrice: 0,
        tools: true,
        reasoning: true,
        addedAt: 0,
        checkedAt: 0,
        missing: false,
      })),
    limit: 2,
  });
}

// the recorded stream behind a fake fetch, and what the fetch received
async function stream(
  body: string,
  status = 200,
): Promise<{ events: ChatEvent[]; init: RequestInit | undefined }> {
  let init: RequestInit | undefined;
  globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
    init = options;
    return new Response(body, {
      status,
      headers: {
        "content-type":
          status === 200 ? "text/event-stream" : "application/json",
      },
    });
  }) as unknown as typeof fetch;
  const events: ChatEvent[] = [];
  for await (const event of provider().chat(
    request,
    new AbortController().signal,
  )) {
    events.push(event);
  }
  return { events, init };
}

describe("OpenRouter catalog", () => {
  test("parses ids, names, windows, prices per million and the flags", () => {
    const models = parseCatalog(catalogBody);
    expect(models.size).toBeGreaterThan(400);
    expect(models.get(FREE)).toEqual({
      id: FREE,
      name: "NVIDIA: Nemotron 3 Super (free)",
      contextLength: 262144,
      promptPrice: 0,
      completionPrice: 0,
      tools: true,
      reasoning: true,
    });
    const sonnet = models.get("anthropic/claude-sonnet-4.5")!;
    expect(sonnet.promptPrice).toBeCloseTo(3, 6);
    expect(sonnet.completionPrice).toBeCloseTo(15, 6);
    expect(sonnet.contextLength).toBe(1000000);
  });

  test("ignores entries without an id and bodies without data", () => {
    expect(parseCatalog({ data: [{ name: "x" }, { id: "" }] }).size).toBe(0);
    expect(parseCatalog(null).size).toBe(0);
    expect(parseCatalog({ data: "no" }).size).toBe(0);
  });

  test("the cache reuses a fetch for a minute and refetches on demand", async () => {
    let calls = 0;
    let now = 1000;
    const fetcher = (async () => {
      calls++;
      return Response.json(catalogBody);
    }) as unknown as typeof fetch;
    const catalog = new Catalog(fetcher, () => now, 60_000);
    expect(catalog.last()).toBeNull();
    const first = await catalog.get();
    await catalog.get();
    expect(calls).toBe(1);
    expect(catalog.last()).toBe(first);
    await catalog.get(true);
    expect(calls).toBe(2);
    now += 61_000;
    await catalog.get();
    expect(calls).toBe(3);
  });

  test("a failed fetch is a CatalogError and keeps the last catalog", async () => {
    let fail = false;
    const fetcher = (async () => {
      if (fail) throw new Error("ECONNRESET");
      return Response.json(catalogBody);
    }) as unknown as typeof fetch;
    const catalog = new Catalog(fetcher);
    const first = await catalog.get();
    fail = true;
    await expect(catalog.get(true)).rejects.toBeInstanceOf(CatalogError);
    await expect(catalog.get(true)).rejects.toThrow("OpenRouter unreachable");
    expect(catalog.last()).toBe(first);
    fail = false;
    const empty = (async () =>
      Response.json({ data: [] })) as unknown as typeof fetch;
    await expect(new Catalog(empty).get()).rejects.toThrow("empty");
    const bad = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(new Catalog(bad).get()).rejects.toThrow("HTTP 500");
  });
});

describe("OpenRouter chat body", () => {
  test("asks for usage, maps thinking to the reasoning object and drops the cache key", () => {
    const body = buildChatBody(request) as any;
    expect(body.usage).toEqual({ include: true });
    expect(body.reasoning).toEqual({ enabled: true });
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
    expect(body.stream).toBe(true);
    expect(body.tools).toHaveLength(1);
    // earlier reasoning goes back as OpenRouter's field, not mlx-serve's
    expect(body.messages[2]).toEqual({
      role: "assistant",
      content: "hello",
      reasoning: "greet back",
    });
    expect(
      (buildChatBody({ ...request, reasoningEffort: "high" }) as any).reasoning,
    ).toEqual({ effort: "high" });
    expect(
      (buildChatBody({ ...request, reasoningEffort: "none" }) as any).reasoning,
    ).toEqual({ effort: "none" });
    expect(
      (buildChatBody({ ...request, thinking: false }) as any).reasoning,
    ).toEqual({ exclude: true, enabled: false });
  });
});

describe("OpenRouter stream", () => {
  test("a tool-calling turn: reasoning, the call, the finish and usage with cost", async () => {
    const { events, init } = await stream(toolsStream);
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers["x-title"]).toBe("mlx-spy");
    const reasoning = events
      .filter((e) => e.kind === "reasoning")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(reasoning.length).toBeGreaterThan(0);
    expect(events.filter((e) => e.kind === "content")).toHaveLength(0);
    const calls = events.find((e) => e.kind === "toolCalls");
    expect(calls).toBeDefined();
    const call = (
      calls as { calls: { name: string; arguments: string; id: string }[] }
    ).calls[0];
    expect(call.name).toBe("get_current_time");
    expect(call.id).toMatch(/^call-/);
    expect(JSON.parse(call.arguments)).toMatchObject({
      timezone: expect.any(String),
    });
    expect(
      events.some((e) => e.kind === "finish" && e.reason === "tool_calls"),
    ).toBe(true);
    const usage = events.find((e) => e.kind === "usage") as Extract<
      ChatEvent,
      { kind: "usage" }
    >;
    expect(usage.stats).toMatchObject({
      cost: 0,
      prefillMs: null,
      decodeMs: null,
    });
    expect(usage.stats.promptTokens).toBeGreaterThan(0);
    expect(usage.stats.generated).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  test("a plain reply streams reasoning then content and ends with usage", async () => {
    const { events } = await stream(plainStream);
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf("reasoning")).toBeLessThan(kinds.indexOf("content"));
    const content = events
      .filter((e) => e.kind === "content")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(content).toMatch(/Mac Studio/);
    const usage = events.find((e) => e.kind === "usage") as Extract<
      ChatEvent,
      { kind: "usage" }
    >;
    expect(usage.stats).toMatchObject({
      promptTokens: 27,
      generated: 141,
      cachedTokens: 0,
      cost: 0,
    });
    expect(events.some((e) => e.kind === "finish" && e.reason === "stop")).toBe(
      true,
    );
    expect(events.some((e) => e.kind === "error")).toBe(false);
  });

  test("a refused request surfaces the upstream's words and nothing else", async () => {
    const { events } = await stream(refused, 429);
    expect(events).toHaveLength(1);
    const [error] = events as Extract<ChatEvent, { kind: "error" }>[];
    expect(error.kind).toBe("error");
    expect(error.message).toBe(
      `OpenRouter 429: ${JSON.parse(refused).error.metadata.raw}`,
    );
    expect(error.message).not.toContain("user_");
    expect(error.message).not.toContain(KEY);
  });

  test("errorText prefers the upstream text, then the message, then the body", () => {
    expect(errorText('{"error":{"message":"bad key"}}')).toBe("bad key");
    expect(errorText("plain text")).toBe("plain text");
    expect(
      errorText(
        '{"error":{"message":"m","metadata":{"raw":"upstream said no"}}}',
      ),
    ).toBe("upstream said no");
  });

  test("the provider lists its models with their windows", () => {
    expect(provider().models()).toEqual([{ id: FREE, contextLength: 262144 }]);
    expect(provider().limit).toBe(2);
    expect(provider().id).toBe("openrouter");
  });
});
