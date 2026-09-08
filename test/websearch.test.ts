import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRequest as buildExaRequest,
  parseAnswer as parseExaAnswer,
} from "../src/tools/search/exa.ts";
import {
  buildRequest as buildFirecrawlRequest,
  parseAnswer as parseFirecrawlAnswer,
} from "../src/tools/search/firecrawl.ts";
import type { SearchProvider } from "../src/tools/search/types.ts";
import {
  loadKey,
  loadSearchKeys,
  parseArgs,
  retryAfterMs,
  type SearchDependencies,
  searchWeb,
  secretsDirFor,
} from "../src/tools/websearch.ts";
import { runTool, type SendBudget, type ToolContext } from "../src/tools.ts";

const exaFixture = await Bun.file(
  new URL("fixtures/exa-search.txt", import.meta.url),
).text();
const firecrawlFixture = await Bun.file(
  new URL("fixtures/firecrawl-search.json", import.meta.url),
).text();
const exaPayload = exaFixture
  .split(/\r?\n/u)
  .find((line) => line.startsWith("data: "))!
  .slice(6);
const exaText = JSON.parse(exaPayload).result.content[0].text as string;
const successEnvelope = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { content: [{ type: "text", text: "result" }] },
});

function budget(): SendBudget {
  return {
    toolCalls: 0,
    fetches: 0,
    searches: 0,
    toolMs: 0,
    resultBytes: 0,
  };
}

function context(
  provider: SearchProvider = "exa",
  key: string | null = null,
  signal = new AbortController().signal,
  sharedBudget = budget(),
): ToolContext {
  return {
    signal,
    now: Date.now,
    engine: new URL("http://engine.invalid"),
    version: "vtest",
    search: { provider, key },
    budget: sharedBudget,
  };
}

function dependencies(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  options: Partial<Pick<SearchDependencies, "deadlineMs" | "sleep">> = {},
): SearchDependencies {
  return {
    fetch: fetcher as typeof fetch,
    deadlineMs: options.deadlineMs ?? 10_000,
    sleep:
      options.sleep ??
      (async (_ms, signal) => {
        signal.throwIfAborted();
      }),
  };
}

function streamResponse(
  chunks: Array<string | Uint8Array>,
  init: ResponseInit = {},
  cancelled?: () => void,
  close = true,
  cancelOutcome: "settle" | "reject" | "hang" = "settle",
): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(
            typeof chunk === "string" ? encoder.encode(chunk) : chunk,
          );
        }
        if (close) controller.close();
      },
      cancel() {
        cancelled?.();
        if (cancelOutcome === "reject") return Promise.reject(new Error("no"));
        if (cancelOutcome === "hang") return new Promise<void>(() => {});
        return undefined;
      },
    }),
    init,
  );
}

function exaResponse(text = successEnvelope): Response {
  return streamResponse([text], {
    headers: { "content-type": "application/json" },
  });
}

function firecrawlResponse(): Response {
  return streamResponse(
    [JSON.stringify({ success: true, data: { web: [] } })],
    { headers: { "content-type": "application/json" } },
  );
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected promise to reject");
}

describe("websearch arguments and registry", () => {
  test("registers the schema and runTool reaches websearch", async () => {
    const result = await runTool(
      { id: "search", name: "websearch", arguments: "{}" },
      context(),
    );
    expect(result).toMatchObject({
      text: "Error: query must be a non-empty string",
      error: "query must be a non-empty string",
    });
  });

  test("validates and normalizes query and domain", () => {
    for (const value of [undefined, "", "   "]) {
      expect(() => parseArgs({ query: value })).toThrow(
        "query must be a non-empty string",
      );
    }
    expect(() => parseArgs({ query: "x".repeat(501) })).toThrow(
      "query must be at most 500 characters",
    );
    expect(parseArgs({ query: "  find docs  " })).toEqual({
      query: "find docs",
      domain: null,
    });
    expect(parseArgs({ query: "find", domain: null })).toEqual({
      query: "find",
      domain: null,
    });
    expect(parseArgs({ query: "find", domain: " FluxCD.io " })).toEqual({
      query: "find",
      domain: "fluxcd.io",
    });
    expect(parseArgs({ query: "find", domain: "fluxcd.io." }).domain).toBe(
      "fluxcd.io",
    );
  });

  test("refuses domains outside the fixed host-name rule", () => {
    for (const domain of [
      "https://fluxcd.io",
      "fluxcd.io/flux",
      "fluxcd.io:443",
      "*.fluxcd.io",
      "flux cd.io",
      "localhost",
      "",
      `${"a".repeat(251)}.io`,
    ]) {
      expect(() => parseArgs({ query: "find", domain }), domain).toThrow(
        "domain must be a host name with at least two labels and at most 253 characters",
      );
    }
  });
});

describe("provider requests", () => {
  test("builds the exact Exa envelope and headers", async () => {
    const request = buildExaRequest(
      { query: "latest kubernetes version", domain: null },
      null,
      "vtest",
    );
    expect(request).toEqual({
      url: "https://mcp.exa.ai/mcp",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "User-Agent": "mlx-spy/vtest",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: { query: "latest kubernetes version", numResults: 5 },
        },
      }),
    });
    expect(
      JSON.parse(
        buildExaRequest(
          { query: "ssh", domain: "fluxcd.io" },
          "secret",
          "vtest",
        ).body,
      ).params.arguments,
    ).toEqual({ query: "ssh site:fluxcd.io", numResults: 5 });
    expect(
      buildExaRequest({ query: "ssh", domain: "fluxcd.io" }, "secret", "vtest")
        .headers["x-api-key"],
    ).toBe("secret");

    const seen: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    await searchWeb(
      { query: "find" },
      context(),
      dependencies(async (input, init) => {
        seen.push({ input, init });
        return exaResponse();
      }),
    );
    expect(String(seen[0].input)).toBe("https://mcp.exa.ai/mcp");
    expect(seen[0].init?.method).toBe("POST");
    expect(seen[0].init?.redirect).toBe("error");
    expect(new Headers(seen[0].init?.headers).get("accept")).toBe(
      "application/json, text/event-stream",
    );
    expect(seen[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("builds the exact Firecrawl body and optional authorization", () => {
    expect(
      buildFirecrawlRequest(
        { query: "latest kubernetes version", domain: null },
        null,
        "vtest",
      ),
    ).toEqual({
      url: "https://api.firecrawl.dev/v2/search",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "mlx-spy/vtest",
      },
      body: JSON.stringify({
        query: "latest kubernetes version",
        limit: 5,
        timeout: 8000,
      }),
    });
    const restricted = buildFirecrawlRequest(
      { query: "ssh", domain: "fluxcd.io" },
      "secret",
      "vtest",
    );
    expect(restricted.headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(restricted.body)).toEqual({
      query: "ssh",
      limit: 5,
      timeout: 8000,
      includeDomains: ["fluxcd.io"],
    });
  });

  test("dispatches the chosen provider with only its selected key", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    for (const [provider, key] of [
      ["exa", "exa-key"],
      ["firecrawl", "firecrawl-key"],
    ] as const) {
      await searchWeb(
        { query: "find" },
        context(provider, key),
        dependencies(async (input, init) => {
          calls.push({
            url: String(input),
            headers: new Headers(init?.headers),
          });
          return provider === "exa" ? exaResponse() : firecrawlResponse();
        }),
      );
    }
    expect(calls[0].url).toBe("https://mcp.exa.ai/mcp");
    expect(calls[0].headers.get("x-api-key")).toBe("exa-key");
    expect(calls[0].headers.get("authorization")).toBeNull();
    expect(calls[1].url).toBe("https://api.firecrawl.dev/v2/search");
    expect(calls[1].headers.get("authorization")).toBe("Bearer firecrawl-key");
    expect(calls[1].headers.get("x-api-key")).toBeNull();
  });
});

describe("Exa answers", () => {
  test("returns the recorded SSE text byte for byte and accepts JSON", () => {
    expect(parseExaAnswer(exaFixture, "text/event-stream", false)).toBe(
      exaText,
    );
    expect(parseExaAnswer(exaPayload, "application/json", false)).toBe(exaText);
  });

  test("joins SSE data lines and multiple text items", () => {
    const split = `event: message\ndata: {"jsonrpc":"2.0","id":1,\ndata: "result":{"content":[{"type":"text","text":"joined"}]}}\n\n`;
    expect(parseExaAnswer(split, "text/event-stream", false)).toBe("joined");
    const multiple = JSON.stringify({
      result: {
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
    });
    expect(parseExaAnswer(multiple, "application/json", false)).toBe(
      "one\n\ntwo",
    );
    expect(
      parseExaAnswer(
        JSON.stringify({ result: { content: [{ type: "text", text: " " }] } }),
        "application/json",
        false,
      ),
    ).toBe("No results.");
  });

  test("rejects malformed SSE, JSON and result shapes", () => {
    for (const [body, type] of [
      ["event: message\n\n", "text/event-stream"],
      ["event: message\ndata: nope\n\n", "text/event-stream"],
      [JSON.stringify({ result: { content: "bad" } }), "application/json"],
    ]) {
      expect(() => parseExaAnswer(body, type, false)).toThrow(
        "websearch answered with an unexpected shape",
      );
    }
  });

  test("passes server errors through and strips the MCP prefix", () => {
    expect(() =>
      parseExaAnswer(
        JSON.stringify({ error: { code: -32602, message: "bad params" } }),
        "application/json",
        false,
      ),
    ).toThrow("bad params");
    const unknown = JSON.stringify({
      result: {
        isError: true,
        content: [
          { type: "text", text: "MCP error -32602: Tool nope not found" },
        ],
      },
    });
    expect(() => parseExaAnswer(unknown, "application/json", false)).toThrow(
      "Tool nope not found",
    );
  });

  test("maps Exa's recorded bad-key result only when a key was sent", async () => {
    const badKey = JSON.stringify({
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: "web_search_exa error (401): Invalid API key",
          },
        ],
      },
    });
    const keyed = await thrown(
      searchWeb(
        { query: "find" },
        context("exa", "bad"),
        dependencies(async () => exaResponse(badKey)),
      ),
    );
    expect(keyed.message).toBe(
      "websearch key rejected: web_search_exa error (401): Invalid API key",
    );
    const keyless = await thrown(
      searchWeb(
        { query: "find" },
        context("exa"),
        dependencies(async () => exaResponse(badKey)),
      ),
    );
    expect(keyless.message).toBe("web_search_exa error (401): Invalid API key");
  });
});

describe("Firecrawl answers", () => {
  test("formats the five recorded hits", () => {
    const source = JSON.parse(firecrawlFixture).data.web as Array<{
      title: string;
      url: string;
      description: string;
    }>;
    const expected = source
      .map(
        (hit, index) =>
          `${index + 1}. ${hit.title}\n${hit.url}\n${hit.description}`,
      )
      .join("\n\n");
    expect(
      parseFirecrawlAnswer(firecrawlFixture, "application/json", true),
    ).toBe(expected);
  });

  test("skips missing URLs, keeps contiguous numbers and empty fields", () => {
    const answer = JSON.stringify({
      success: true,
      data: {
        web: [
          { title: "one", url: "https://one", description: "first" },
          { title: "drop", description: "missing URL" },
          { title: 3, url: "https://three", description: 3 },
        ],
      },
    });
    expect(parseFirecrawlAnswer(answer, "application/json", false)).toBe(
      "1. one\nhttps://one\nfirst\n\n2. \nhttps://three\n",
    );
    expect(
      parseFirecrawlAnswer(
        JSON.stringify({ success: true, data: { web: [] } }),
        "application/json",
        false,
      ),
    ).toBe("No results.");
  });

  test("reports provider and shape errors", () => {
    expect(() =>
      parseFirecrawlAnswer(
        JSON.stringify({ success: false, error: "denied" }),
        "application/json",
        false,
      ),
    ).toThrow("denied");
    for (const body of [
      "not json",
      JSON.stringify({ success: true }),
      JSON.stringify({ success: true, data: {} }),
    ]) {
      expect(() =>
        parseFirecrawlAnswer(body, "application/json", false),
      ).toThrow("websearch answered with an unexpected shape");
    }
  });
});

describe("websearch HTTP policy", () => {
  test("retries one 429, cancels it and reuses the deadline signal", async () => {
    let cancelled = 0;
    const sleeps: number[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    let calls = 0;
    const result = await searchWeb(
      { query: "find" },
      context(),
      dependencies(
        async (_input, init) => {
          signals.push(init?.signal);
          calls++;
          if (calls === 1) {
            return streamResponse(
              ["rate limited"],
              { status: 429, headers: { "retry-after": "1" } },
              () => cancelled++,
              false,
            );
          }
          return exaResponse();
        },
        {
          deadlineMs: 5000,
          sleep: async (ms, signal) => {
            signal.throwIfAborted();
            sleeps.push(ms);
          },
        },
      ),
    );
    expect(result).toBe("result");
    expect(cancelled).toBe(1);
    expect(sleeps).toEqual([1000]);
    expect(signals).toHaveLength(2);
    expect(signals[1]).toBe(signals[0]);
  });

  test("retries a Firecrawl 429 the same way", async () => {
    let calls = 0;
    const result = await searchWeb(
      { query: "find" },
      context("firecrawl", "fc-key"),
      dependencies(async (input) => {
        calls++;
        expect(String(input)).toBe("https://api.firecrawl.dev/v2/search");
        if (calls === 1) {
          return streamResponse([], { status: 429 }, undefined, false);
        }
        return firecrawlResponse();
      }),
    );
    expect(result).toBe("No results.");
    expect(calls).toBe(2);
  });

  test("cancels two 429 bodies and then reports rate limiting", async () => {
    let cancelled = 0;
    const error = await thrown(
      searchWeb(
        { query: "find" },
        context(),
        dependencies(
          async () =>
            streamResponse(
              ["limited"],
              { status: 429, headers: { "retry-after": "0" } },
              () => cancelled++,
              false,
            ),
          { deadlineMs: 5000 },
        ),
      ),
    );
    expect(error.message).toBe("websearch rate limited, try again in a moment");
    expect(cancelled).toBe(2);
  });

  test("parses retry-after and refuses waits outside the deadline", async () => {
    expect(retryAfterMs(null)).toBe(1000);
    expect(retryAfterMs("abc")).toBe(1000);
    expect(retryAfterMs("")).toBe(1000);
    expect(retryAfterMs("  ")).toBe(1000);
    expect(retryAfterMs("-1")).toBe(1000);
    expect(retryAfterMs("0")).toBe(0);
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs("30")).toBeNull();
    expect(retryAfterMs("1.5")).toBeNull();
    expect(retryAfterMs("Tue, 08 Sep 2026 20:00:00 GMT")).toBeNull();

    for (const [header, deadlineMs] of [
      ["30", 10_000],
      ["1", 50],
    ] as const) {
      let calls = 0;
      let sleeps = 0;
      const error = await thrown(
        searchWeb(
          { query: "find" },
          context(),
          dependencies(
            async () => {
              calls++;
              return streamResponse(
                ["limited"],
                { status: 429, headers: { "retry-after": header } },
                undefined,
                false,
              );
            },
            {
              deadlineMs,
              sleep: async () => {
                sleeps++;
              },
            },
          ),
        ),
      );
      expect(error.message).toBe(
        "websearch rate limited, try again in a moment",
      );
      expect(calls).toBe(1);
      expect(sleeps).toBe(0);
    }
  });

  test("maps HTTP errors for both providers", async () => {
    for (const provider of ["exa", "firecrawl"] as const) {
      const withText = await thrown(
        searchWeb(
          { query: "find" },
          context(provider),
          dependencies(async () =>
            streamResponse([JSON.stringify({ error: "server broke" })], {
              status: 500,
            }),
          ),
        ),
      );
      expect(withText.message).toBe(
        "websearch failed (HTTP 500): server broke",
      );
      const withoutText = await thrown(
        searchWeb(
          { query: "find" },
          context(provider),
          dependencies(async () =>
            streamResponse(["<html>bad gateway</html>"], { status: 502 }),
          ),
        ),
      );
      expect(withoutText.message).toBe("websearch failed (HTTP 502)");
    }
  });

  test("maps Firecrawl's keyless refusal and a rejected key", async () => {
    const refusal =
      '{"success":false,"error":"Unfortunately, your IP address looks suspicious, so Firecrawl can\'t be used without an API key from here."}';
    const refused = await thrown(
      searchWeb(
        { query: "find" },
        context("firecrawl"),
        dependencies(async () => streamResponse([refusal], { status: 403 })),
      ),
    );
    expect(refused.message).toBe(
      "websearch refused: Unfortunately, your IP address looks suspicious, so Firecrawl can't be used without an API key from here.",
    );
    const rejected = await thrown(
      searchWeb(
        { query: "find" },
        context("firecrawl", "bad"),
        dependencies(async () =>
          streamResponse(
            [JSON.stringify({ success: false, error: "Invalid API key" })],
            { status: 401 },
          ),
        ),
      ),
    );
    expect(rejected.message).toBe("websearch key rejected: Invalid API key");
  });

  test("cleans and bounds server error text", async () => {
    const dirty = ` first\nsecond\u0000\tthird ${"x".repeat(5000)}`;
    const error = await thrown(
      searchWeb(
        { query: "find" },
        context(),
        dependencies(async () =>
          streamResponse([JSON.stringify({ error: dirty })], { status: 500 }),
        ),
      ),
    );
    expect(error.message).toStartWith(
      "websearch failed (HTTP 500): first second third ",
    );
    expect(
      error.message.slice("websearch failed (HTTP 500): ".length),
    ).toHaveLength(300);
    expect(error.message).not.toContain("\n");
    expect(error.message).not.toContain("\u0000");
  });
});

describe("websearch limits and cancellation", () => {
  test("cancels and reports a body over 1 MB", async () => {
    let cancelled = 0;
    const error = await thrown(
      searchWeb(
        { query: "find" },
        context(),
        dependencies(async () =>
          streamResponse(
            [new Uint8Array(1024 * 1024), new Uint8Array([1])],
            { headers: { "content-type": "application/json" } },
            () => cancelled++,
            false,
          ),
        ),
      ),
    );
    expect(error.message).toBe("websearch answer over 1 MB");
    expect(cancelled).toBe(1);
  });

  test("keeps its error when the body cancel rejects or hangs", async () => {
    for (const outcome of ["reject", "hang"] as const) {
      const over = await thrown(
        searchWeb(
          { query: "find" },
          context(),
          dependencies(async () =>
            streamResponse(
              [new Uint8Array(1024 * 1024), new Uint8Array([1])],
              { headers: { "content-type": "application/json" } },
              undefined,
              false,
              outcome,
            ),
          ),
        ),
      );
      expect(over.message).toBe("websearch answer over 1 MB");
      let calls = 0;
      const limited = await thrown(
        searchWeb(
          { query: "find" },
          context(),
          dependencies(async () => {
            calls++;
            return streamResponse(
              [],
              { status: 429, headers: { "retry-after": "0" } },
              undefined,
              false,
              outcome,
            );
          }),
        ),
      );
      expect(limited.message).toBe(
        "websearch rate limited, try again in a moment",
      );
      expect(calls).toBe(2);
    }
  });

  test("aborts an in-flight body read with the caller's reason", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    let cancelled = 0;
    const pending = searchWeb(
      { query: "find" },
      context("exa", null, controller.signal),
      dependencies(async () => {
        queueMicrotask(() => setTimeout(() => controller.abort(reason), 5));
        return streamResponse([], {}, () => cancelled++, false);
      }),
    );
    expect(await thrown(pending)).toBe(reason);
    expect(cancelled).toBe(1);
  });

  test("times out a body reader that never yields and cancels it", async () => {
    let cancelled = 0;
    const error = await thrown(
      searchWeb(
        { query: "find" },
        context(),
        dependencies(
          async () => streamResponse([], {}, () => cancelled++, false),
          { deadlineMs: 30 },
        ),
      ),
    );
    expect(error.message).toBe("search timed out after 10 seconds");
    expect(cancelled).toBe(1);
  });

  test("enforces three searches synchronously across parallel calls", async () => {
    const shared = budget();
    let fetches = 0;
    const calls = Array.from({ length: 4 }, () =>
      searchWeb(
        { query: "find" },
        context("exa", null, new AbortController().signal, shared),
        dependencies(async () => {
          fetches++;
          return exaResponse();
        }),
      ),
    );
    const results = await Promise.allSettled(calls);
    expect(fetches).toBe(3);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(3);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason.message).toBe("search limit reached");
  });

  test("times out fetch even when it ignores the signal", async () => {
    const error = await thrown(
      searchWeb(
        { query: "find" },
        context(),
        dependencies(async () => new Promise<Response>(() => {}), {
          deadlineMs: 30,
        }),
      ),
    );
    expect(error.message).toBe("search timed out after 10 seconds");
  });

  test("propagates the caller abort reason and network failures", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    controller.abort(reason);
    let called = false;
    expect(
      await thrown(
        searchWeb(
          { query: "find" },
          context("exa", null, controller.signal),
          dependencies(async () => {
            called = true;
            return exaResponse();
          }),
        ),
      ),
    ).toBe(reason);
    expect(called).toBe(false);

    const network = await thrown(
      searchWeb(
        { query: "find" },
        context(),
        dependencies(async () => {
          throw new Error("network down");
        }),
      ),
    );
    expect(network.message).toBe("network down");
  });
});

describe("search key files", () => {
  test("loads valid keys and rejects invalid files with their paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "mlx-spy-search-"));
    try {
      const missing = join(dir, "missing.key");
      expect(loadKey(missing)).toBeNull();
      const valid = join(dir, "valid.key");
      writeFileSync(valid, "secret\n");
      expect(loadKey(valid)).toBe("secret");
      const invalid = [
        ["empty.key", ""],
        ["space.key", " \n"],
        ["large.key", "x".repeat(4097)],
        ["control.key", "bad\u0001key"],
        ["unicode.key", "sécret"],
      ] as const;
      for (const [name, value] of invalid) {
        const path = join(dir, name);
        writeFileSync(path, value);
        expect(() => loadKey(path), name).toThrow(path);
      }
      const directory = join(dir, "directory.key");
      mkdirSync(directory);
      expect(() => loadKey(directory)).toThrow(directory);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads each provider independently", () => {
    const dir = mkdtempSync(join(tmpdir(), "mlx-spy-search-"));
    try {
      writeFileSync(join(dir, "exa.key"), "exa-secret");
      expect(loadSearchKeys(dir)).toEqual({
        exa: "exa-secret",
        firecrawl: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolves source and binary secret directories", () => {
    expect(secretsDirFor("/r/src/main.ts", "/opt/bun")).toBe(
      "/r/.preview/secrets",
    );
    expect(
      secretsDirFor("/$bunfs/root/mlx-spy", "/u/.mlx-spy/bin/mlx-spy"),
    ).toBe("/u/.mlx-spy/secrets");
  });
});
