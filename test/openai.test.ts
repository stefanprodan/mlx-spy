import { afterEach, describe, expect, test } from "bun:test";
import {
  buildChatBody,
  chatEvents,
  streamChat,
  ToolCallTracker,
} from "../src/engine/openai.ts";
import type { ChatEvent, ChatRequest } from "../src/engine/types.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const request: ChatRequest = {
  model: "org/model",
  messages: [{ role: "user", content: "hello" }],
  thinking: false,
  temperature: null,
  topP: null,
  maxTokens: null,
};

function delta(
  fields: Omit<Extract<ChatEvent, { kind: "toolCallDelta" }>, "kind">,
): Extract<ChatEvent, { kind: "toolCallDelta" }> {
  return { kind: "toolCallDelta", ...fields };
}

async function streamed(frames: object[], done = true): Promise<ChatEvent[]> {
  const text =
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
    (done ? "data: [DONE]\n\n" : "");
  globalThis.fetch = (async () =>
    new Response(text, {
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
  const events: ChatEvent[] = [];
  for await (const event of streamChat(
    "http://fake/v1/chat/completions",
    buildChatBody(request),
    new AbortController().signal,
  )) {
    events.push(event);
  }
  return events;
}

describe("OpenAI chat body", () => {
  test("maps a tool-calling history and omits empty tools", () => {
    const body = buildChatBody({
      ...request,
      messages: [
        { role: "system", content: "be helpful" },
        { role: "user", content: "what time is it?" },
        {
          role: "assistant",
          content: "",
          reasoning: "I should check",
          toolCalls: [
            {
              id: "call_time",
              name: "get_current_time",
              arguments: '{"timezone":"UTC"}',
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_time",
          content: '{"datetime":"2026-09-08T15:00:00Z"}',
        },
      ],
      tools: [],
      temperature: 0,
      topP: 0.8,
      maxTokens: 100,
    });
    expect(body).toEqual({
      model: "org/model",
      messages: [
        { role: "system", content: "be helpful" },
        { role: "user", content: "what time is it?" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "I should check",
          tool_calls: [
            {
              id: "call_time",
              type: "function",
              function: {
                name: "get_current_time",
                arguments: '{"timezone":"UTC"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_time",
          content: '{"datetime":"2026-09-08T15:00:00Z"}',
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
      top_p: 0.8,
      max_tokens: 100,
    });
    expect(body).not.toHaveProperty("tools");
  });

  test("sends the cache key as prompt_cache_key only when set", () => {
    expect(buildChatBody(request)).not.toHaveProperty("prompt_cache_key");
    expect(buildChatBody({ ...request, cacheKey: null })).not.toHaveProperty(
      "prompt_cache_key",
    );
    expect(
      buildChatBody({ ...request, cacheKey: "chat-1" }).prompt_cache_key,
    ).toBe("chat-1");
  });

  test("maps non-empty tools to OpenAI function schemas", () => {
    expect(
      buildChatBody({
        ...request,
        tools: [
          {
            name: "clock",
            description: "Read a clock",
            parameters: { type: "object", properties: {} },
          },
        ],
      }).tools,
    ).toEqual([
      {
        type: "function",
        function: {
          name: "clock",
          description: "Read a clock",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });
});

describe("OpenAI chat events", () => {
  test("maps content, reasoning, optional tool fields and finish", () => {
    expect(
      chatEvents(
        JSON.stringify({
          choices: [
            {
              delta: {
                content: null,
                reasoning_content: "think",
                tool_calls: [
                  { function: { arguments: "{" } },
                  { index: 2, id: "two", function: { name: "clock" } },
                ],
              },
              finish_reason: "stop",
            },
          ],
        }),
      ),
    ).toEqual([
      { kind: "reasoning", text: "think" },
      { kind: "toolCallDelta", arguments: "{" },
      { kind: "toolCallDelta", index: 2, id: "two", name: "clock" },
      { kind: "finish", reason: "stop", details: null },
    ]);
  });

  test("maps usage without timing extensions", () => {
    expect(
      chatEvents(
        JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 7 },
          },
        }),
      ),
    ).toEqual([
      {
        kind: "usage",
        stats: {
          promptTokens: 12,
          cachedTokens: 7,
          generated: 4,
          prefillMs: null,
          decodeMs: null,
          tokenizeMs: null,
        },
      },
    ]);
  });
});

describe("ToolCallTracker", () => {
  test("joins fragmented arguments when the name arrives last", () => {
    const tracker = new ToolCallTracker();
    tracker.push(delta({ index: 0, arguments: '{"time' }));
    tracker.push(delta({ index: 0, arguments: 'zone":"' }));
    tracker.push(delta({ index: 0, arguments: 'UTC"}' }));
    tracker.push(delta({ id: "server_call", name: "get_current_time" }));
    expect(tracker.flush()).toEqual([
      {
        id: "server_call",
        name: "get_current_time",
        arguments: '{"timezone":"UTC"}',
      },
    ]);
  });

  test("tracks items without indexes by id and then by latest call", () => {
    const tracker = new ToolCallTracker();
    tracker.push(delta({ id: "first", arguments: "{" }));
    tracker.push(delta({ arguments: "}" }));
    tracker.push(delta({ id: "first", name: "one" }));
    tracker.push(delta({ id: "second", name: "two", arguments: "" }));
    expect(tracker.flush()).toEqual([
      { id: "first", name: "one", arguments: "{}" },
      { id: "second", name: "two", arguments: "" },
    ]);
  });

  test("orders sparse indexed calls and synthesises missing ids", () => {
    const tracker = new ToolCallTracker();
    tracker.push(delta({ index: 2, name: "later", arguments: "2" }));
    tracker.push(delta({ index: 0, name: "first", arguments: "0" }));
    expect(tracker.flush()).toEqual([
      { id: "call_0", name: "first", arguments: "0" },
      { id: "call_1", name: "later", arguments: "2" },
    ]);
  });
});

describe("OpenAI chat stream", () => {
  test("flushes calls after stop without a usage chunk", async () => {
    const events = await streamed([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_one",
                  function: { name: "clock", arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
      },
    ]);
    expect(events.at(-1)).toEqual({
      kind: "toolCalls",
      calls: [{ id: "call_one", name: "clock", arguments: "{}" }],
    });
    expect(events.some((event) => event.kind === "usage")).toBe(false);
  });

  test("flushes partial calls after length and after a later usage", async () => {
    const events = await streamed([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { name: "fetch", arguments: '{"url":' },
                },
              ],
            },
            finish_reason: "length",
          },
        ],
      },
      {
        choices: [],
        usage: { prompt_tokens: 8, completion_tokens: 2 },
      },
    ]);
    expect(events.map((event) => event.kind)).toEqual([
      "toolCallDelta",
      "finish",
      "usage",
      "toolCalls",
    ]);
    expect(events.at(-1)).toEqual({
      kind: "toolCalls",
      calls: [{ id: "call_0", name: "fetch", arguments: '{"url":' }],
    });
  });

  test("flushes calls at EOF and reports a missing finish", async () => {
    const events = await streamed(
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [{ function: { name: "clock", arguments: "" } }],
              },
              finish_reason: null,
            },
          ],
        },
      ],
      false,
    );
    expect(events.slice(-2)).toEqual([
      {
        kind: "toolCalls",
        calls: [{ id: "call_0", name: "clock", arguments: "" }],
      },
      { kind: "error", message: "stream ended early" },
    ]);
  });
});
