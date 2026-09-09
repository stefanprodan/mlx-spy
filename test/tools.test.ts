import { describe, expect, test } from "bun:test";
import { dateLine } from "../src/tools/time.ts";
import {
  formatCurrentTime,
  runTool,
  type SendBudget,
  TOOLS,
  toolSchemas,
} from "../src/tools.ts";

const now = Date.UTC(2026, 8, 8, 14, 42, 10);
const budget: SendBudget = {
  toolCalls: 0,
  fetches: 0,
  searches: 0,
  toolMs: 0,
  resultBytes: 0,
};

function context() {
  return {
    signal: new AbortController().signal,
    now: () => now,
    engine: new URL("http://engine.invalid"),
    version: "vtest",
    search: { provider: "exa" as const, key: null },
    budget,
  };
}

describe("formatCurrentTime", () => {
  test("formats a fixed instant with the requested zone offset", () => {
    expect(formatCurrentTime(now, "Europe/Bucharest")).toEqual({
      timezone: "Europe/Bucharest",
      datetime: "2026-09-08T17:42:10+03:00",
      day_of_week: "Tuesday",
    });
    expect(formatCurrentTime(now, "Asia/Tokyo").datetime).toBe(
      "2026-09-08T23:42:10+09:00",
    );
    expect(formatCurrentTime(now, "America/New_York").datetime).toBe(
      "2026-09-08T10:42:10-04:00",
    );
    // the day rolls over with the zone
    expect(dateLine(now, "Europe/Bucharest")).toBe(
      "Today's date: Tuesday, 2026-09-08",
    );
    expect(dateLine(now, "Pacific/Auckland")).toBe(
      "Today's date: Wednesday, 2026-09-09",
    );
  });

  test("names an invalid timezone", () => {
    expect(() => formatCurrentTime(now, "Mars/Olympus")).toThrow(
      'unknown timezone "Mars/Olympus"',
    );
  });
});

describe("tool registry", () => {
  test("returns schemas for all or selected enabled tools", () => {
    expect(toolSchemas().map((tool) => tool.name)).toEqual([
      "get_current_time",
      "webfetch",
      "websearch",
    ]);
    expect(toolSchemas([])).toEqual([]);
    expect(toolSchemas(["websearch"], now)[0].description).toContain(
      "The current year is 2026",
    );
    expect(toolSchemas(["websearch"], now)[0].description).not.toContain(
      "{{year}}",
    );
    const fetch = toolSchemas(["webfetch"])[0];
    expect(fetch.parameters).toMatchObject({
      required: ["url"],
      properties: {
        max_length: { type: "integer", minimum: 1, maximum: 50_000 },
        start_index: { type: "integer", minimum: 0 },
      },
    });
    expect(toolSchemas(["get_current_time"])[0].parameters).toMatchObject({
      required: ["timezone"],
    });
    expect(toolSchemas(["websearch"])[0].parameters).toMatchObject({
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        domain: { type: "string" },
      },
    });
  });

  test("runs get_current_time and accepts empty arguments as an object", async () => {
    const result = await runTool(
      {
        id: "call_1",
        name: "get_current_time",
        arguments: '{"timezone":"UTC"}',
      },
      context(),
    );
    expect(result.error).toBeNull();
    expect(JSON.parse(result.text)).toEqual({
      timezone: "UTC",
      datetime: "2026-09-08T14:42:10+00:00",
      day_of_week: "Tuesday",
    });

    const empty = await runTool(
      { id: "call_2", name: "get_current_time", arguments: "" },
      context(),
    );
    expect(empty).toMatchObject({
      text: "Error: timezone must be a non-empty string",
      error: "timezone must be a non-empty string",
    });
  });

  test("turns unknown tools, bad JSON and invalid zones into results", async () => {
    expect(
      await runTool({ id: "x", name: "missing", arguments: "{}" }, context()),
    ).toEqual({
      text: 'Error: tool "missing" not found.',
      error: 'tool "missing" not found.',
    });
    expect(
      await runTool(
        { id: "x", name: "get_current_time", arguments: "{" },
        context(),
      ),
    ).toMatchObject({
      error: 'invalid JSON arguments for tool "get_current_time"',
    });
    expect(
      await runTool(
        {
          id: "x",
          name: "get_current_time",
          arguments: '{"timezone":"Not/AZone"}',
        },
        context(),
      ),
    ).toMatchObject({ error: 'unknown timezone "Not/AZone"' });
  });

  test("strips control characters and caps result text", async () => {
    TOOLS.push({
      name: "test_result",
      description: "test",
      parameters: {},
      async run() {
        return `a\u0000\tb\nc${"x".repeat(60_000)}`;
      },
    });
    try {
      const result = await runTool(
        { id: "x", name: "test_result", arguments: "{}" },
        context(),
      );
      expect(result.error).toBeNull();
      expect(result.text.startsWith("a\tb\nc")).toBe(true);
      expect(result.text.length).toBe(50_000);
    } finally {
      TOOLS.pop();
    }
  });
});
