import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { ChatError, ChatRunner, type ChatWsEvent } from "../src/chat.ts";
import { ChatStore } from "../src/chats.ts";
import { mlxServeProvider } from "../src/engine/mlxserve.ts";
import type {
  CacheLimits,
  Capability,
  ChatEvent,
  ChatMessageIn,
  ChatRequest,
  Engine,
  EngineMetrics,
  ModelInfo,
  ToolCall,
} from "../src/engine/types.ts";
import { TOOLS, type ToolContext } from "../src/tools.ts";
import { applyEvent, stateOf } from "../src/ui/chat/events.ts";

const MODEL = "org/Qwen3.8-27B";
const model: ModelInfo = {
  id: MODEL,
  loaded: true,
  state: "ready",
  bytesResident: 1,
  bytesOnDisk: 1,
  contextLength: 1000,
  capabilities: ["chat"],
};

class DrivenStream {
  private values: ChatEvent[] = [];
  private waiters: ((result: IteratorResult<ChatEvent>) => void)[] = [];
  private ended = false;
  private error: Error | null = null;

  push(event: ChatEvent) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.values.push(event);
  }

  end() {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  fail(error: Error) {
    this.error = error;
    this.end();
  }

  async *iterate(): AsyncIterable<ChatEvent> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift()!;
        continue;
      }
      if (this.error) throw this.error;
      if (this.ended) return;
      const result = await new Promise<IteratorResult<ChatEvent>>((resolve) =>
        this.waiters.push(resolve),
      );
      if (result.done) {
        if (this.error) throw this.error;
        return;
      }
      yield result.value;
    }
  }
}

class FakeEngine implements Engine {
  readonly id = "mlxserve" as const;
  readonly url = "http://fake";
  streams: DrivenStream[] = [];
  requests: ChatRequest[] = [];
  signals: AbortSignal[] = [];

  async *chat(req: ChatRequest, signal: AbortSignal) {
    const stream = new DrivenStream();
    this.streams.push(stream);
    this.requests.push(req);
    this.signals.push(signal);
    yield* stream.iterate();
  }
  async health() {
    return true;
  }
  async models() {
    return [model];
  }
  async metrics(): Promise<EngineMetrics> {
    throw new Error("unused");
  }
  async load() {}
  async unload() {}
  capabilities(): Set<Capability> {
    return new Set(["chat"]);
  }
  cacheDirs() {
    return [];
  }
  logFile() {
    return null;
  }
  processNames() {
    return [];
  }
  serviceLabel() {
    return null;
  }
  async cacheLimits(): Promise<CacheLimits | null> {
    return null;
  }
}

function setup(
  list: ModelInfo[] = [model],
  executeTool?: (
    call: ToolCall,
    ctx: ToolContext,
  ) => Promise<{ text: string; error: string | null }>,
) {
  let now = 1000;
  const models = [...list];
  const db = new Database(":memory:", { strict: true });
  const store = new ChatStore(
    db,
    () => now,
    () => TOOLS.map((tool) => tool.name),
  );
  const engine = new FakeEngine();
  const events: ChatWsEvent[] = [];
  const logs: string[] = [];
  const runner = new ChatRunner({
    engine,
    providers: {
      mlxserve: mlxServeProvider(engine, () => models),
      openrouter: null,
    },
    store,
    log: (line) => logs.push(line),
    now: () => now,
    runTool: executeTool,
    searchKeys: { exa: "exa-key", firecrawl: "firecrawl-key" },
  });
  runner.onEvent((event) => events.push(event));
  const chat = runner.create({
    provider: "mlxserve",
    model: MODEL,
    systemPrompt: "be concise",
    thinking: true,
    reasoningEffort: "low",
    reasoningHistory: false,
    temperature: 0.5,
    topP: 0.9,
    maxTokens: 100,
    toolsOff: TOOLS.map((tool) => tool.name),
    search: "exa",
  });
  events.length = 0;
  return {
    db,
    store,
    engine,
    runner,
    chat,
    events,
    logs,
    models,
    setNow(value: number) {
      now = value;
    },
  };
}

// the row a running send is writing, as the old single-send snapshot
// field named it; a stopping send is not running
function running(
  runner: ChatRunner,
): { chatId: string; messageId: number } | null {
  const send = runner.runs().sends.find((run) => run.phase === "running");
  return send ? { chatId: send.chatId, messageId: send.messageId } : null;
}

async function turn() {
  await Bun.sleep(0);
  await Bun.sleep(0);
}

async function finish(stream: DrivenStream) {
  stream.push({ kind: "finish", reason: "stop", details: null });
  stream.push({
    kind: "usage",
    stats: {
      promptTokens: 10,
      cachedTokens: 4,
      generated: 3,
      prefillMs: 20,
      decodeMs: 30,
      tokenizeMs: 1,
      cost: null,
    },
  });
  stream.end();
  await turn();
}

async function rejects(fn: () => unknown, status: number, match: RegExp) {
  let error: unknown;
  try {
    await fn();
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ChatError);
  expect((error as ChatError).status).toBe(status);
  expect((error as Error).message).toMatch(match);
}

async function calls(
  stream: DrivenStream,
  toolCalls: ToolCall[],
  reason = "tool_calls",
) {
  stream.push({ kind: "toolCallDelta", index: 0 });
  stream.push({ kind: "finish", reason, details: null });
  stream.push({ kind: "toolCalls", calls: toolCalls });
  stream.end();
  await turn();
  await turn();
}

const EXHAUSTED = "Tool calls are exhausted for this turn; answer with text.";

const clock = (id: string, timezone = "UTC"): ToolCall => ({
  id,
  name: "get_current_time",
  arguments: JSON.stringify({ timezone }),
});

describe("ChatRunner", () => {
  test("inserts rows, publishes offsets, throttles writes and finishes", async () => {
    const s = setup();
    const started = s.runner.send(s.chat.id, "hello");
    expect(started.user).toMatchObject({ role: "user", content: "hello" });
    expect(started.message).toMatchObject({
      role: "assistant",
      status: "streaming",
      model: MODEL,
    });
    expect(s.events.find((event) => event.kind === "chat")).toMatchObject({
      kind: "chat",
      chat: { title: "hello" },
    });
    expect(s.events.find((event) => event.kind === "started")).toMatchObject({
      kind: "started",
      user: started.user,
    });
    expect(running(s.runner)).toEqual({
      chatId: s.chat.id,
      messageId: started.message.id,
    });
    await turn();
    const stream = s.engine.streams[0];
    expect(s.engine.requests[0]).toMatchObject({
      model: MODEL,
      thinking: true,
      reasoningEffort: "low",
      temperature: 0.5,
      topP: 0.9,
      maxTokens: 100,
      cacheKey: s.chat.id,
      messages: [
        {
          role: "system",
          content: "be concise\n\nToday's date: Thursday, 1970-01-01",
        },
        { role: "user", content: "hello" },
      ],
    });
    stream.push({ kind: "reasoning", text: "💭" });
    stream.push({ kind: "content", text: "hi" });
    await turn();
    const deltas = s.events.filter((event) => event.kind === "delta");
    expect(deltas).toEqual([
      {
        kind: "delta",
        chatId: s.chat.id,
        messageId: started.message.id,
        content: undefined,
        contentAt: 0,
        reasoning: "💭",
        reasoningAt: 0,
      },
      {
        kind: "delta",
        chatId: s.chat.id,
        messageId: started.message.id,
        content: "hi",
        contentAt: 0,
        reasoning: undefined,
        reasoningAt: 2,
      },
    ]);
    expect(s.store.message(started.message.id)?.content).toBe("");
    s.setNow(1300);
    stream.push({ kind: "content", text: " there" });
    await turn();
    expect(s.store.message(started.message.id)).toMatchObject({
      content: "hi there",
      reasoning: "💭",
    });
    s.setNow(1600);
    await finish(stream);
    const done = s.store.message(started.message.id)!;
    expect(done).toMatchObject({
      status: "done",
      content: "hi there",
      reasoning: "💭",
      finishReason: "stop",
      ttftMs: 0,
      stats: {
        promptTokens: 10,
        cachedTokens: 4,
        generated: 3,
      },
    });
    expect(done.html).toContain("hi there");
    expect(s.events.some((event) => event.kind === "html")).toBe(true);
    expect(s.events.at(-1)).toMatchObject({ kind: "done", message: done });
    expect(running(s.runner)).toBeNull();
    expect(s.logs[0]).toBe(`chat ${s.chat.id} sent ${MODEL}`);
    expect(s.logs.at(-1)).toMatch(/done 10\+3 tokens/);
    s.db.close();
  });

  test("stop keeps partial text, records TTFT and aborts the engine", async () => {
    const s = setup();
    const { message } = s.runner.send(s.chat.id, "hello");
    await turn();
    s.setNow(1100);
    s.engine.streams[0].push({ kind: "content", text: "partial" });
    await turn();
    s.runner.stop(s.chat.id);
    expect(s.engine.signals[0].aborted).toBe(true);
    expect(s.store.message(message.id)).toMatchObject({
      status: "stopped",
      content: "partial",
      ttftMs: 100,
      stats: null,
    });
    expect(s.events.at(-1)).toMatchObject({
      kind: "done",
      message: { status: "stopped" },
    });
    expect(running(s.runner)).toBeNull();
    s.runner.stop(s.chat.id);
    s.engine.streams[0].end();
    await turn();
    s.db.close();
  });

  test("blocks a new send until an aborted iterator has drained", async () => {
    const s = setup();
    s.runner.send(s.chat.id, "first");
    await turn();
    const stream = s.engine.streams[0];
    s.runner.stop(s.chat.id);
    await rejects(
      () => s.runner.send(s.chat.id, "second"),
      409,
      /Still cancelling the previous reply/,
    );
    stream.end();
    await turn();
    expect(() => s.runner.send(s.chat.id, "second")).not.toThrow();
    await turn();
    s.runner.stop(s.chat.id);
    s.engine.streams[1].end();
    await turn();
    s.db.close();
  });

  test("engine errors, thrown reads and truncated streams become errors", async () => {
    const s = setup();
    const first = s.runner.send(s.chat.id, "one");
    await turn();
    s.engine.streams[0].push({ kind: "error", message: "out of memory" });
    await turn();
    expect(s.store.message(first.message.id)).toMatchObject({
      status: "error",
      error: "out of memory",
    });

    const second = s.runner.send(s.chat.id, "two");
    await turn();
    s.engine.streams[1].fail(new Error("connection reset"));
    await turn();
    expect(s.store.message(second.message.id)?.error).toBe("connection reset");

    const third = s.runner.send(s.chat.id, "three");
    await turn();
    s.engine.streams[2].end();
    await turn();
    expect(s.store.message(third.message.id)).toMatchObject({
      status: "error",
      error: "stream ended early",
    });

    const fourth = s.runner.send(s.chat.id, "four");
    await turn();
    s.engine.streams[3].push({
      kind: "finish",
      reason: "error",
      details: null,
    });
    s.engine.streams[3].end();
    await turn();
    expect(s.store.message(fourth.message.id)).toMatchObject({
      status: "error",
      error: "engine generation failed",
    });
    s.db.close();
  });

  test("rejects a second generation with the running chat title", async () => {
    const s = setup();
    s.runner.send(s.chat.id, "first title");
    await rejects(
      () => s.runner.send(s.chat.id, "second"),
      409,
      /already answering in first title/,
    );
    s.runner.stop(s.chat.id);
    await turn();
    s.engine.streams[0].end();
    await turn();
    s.db.close();
  });

  test("regenerate reuses the user and edit truncates before resending", async () => {
    const s = setup();
    const first = s.runner.send(s.chat.id, "original");
    await turn();
    await finish(s.engine.streams[0]);
    const regenerated = s.runner.regenerate(s.chat.id);
    expect(regenerated.user.id).toBe(first.user.id);
    expect(regenerated.message.id).not.toBe(first.message.id);
    expect(s.store.get(s.chat.id)?.messages).toHaveLength(2);
    await turn();
    s.engine.streams[1].push({ kind: "content", text: "new answer" });
    await finish(s.engine.streams[1]);

    const edited = s.runner.edit(s.chat.id, first.user.id, "edited");
    expect(edited.user.id).not.toBe(first.user.id);
    expect(s.store.get(s.chat.id)?.messages.map((row) => row.content)).toEqual([
      "edited",
      "",
    ]);
    await turn();
    expect(s.engine.requests[2].messages.at(-1)).toEqual({
      role: "user",
      content: "edited",
    });
    s.runner.stop(s.chat.id);
    s.engine.streams[2].end();
    await turn();
    s.db.close();
  });

  test("validates edit and regenerate before deleting conversation rows", async () => {
    const s = setup();
    const first = s.runner.send(s.chat.id, "original");
    await turn();
    await finish(s.engine.streams[0]);
    const before = s.store.get(s.chat.id)!.messages;
    s.models.length = 0;

    await rejects(
      () => s.runner.edit(s.chat.id, first.user.id, "edited"),
      400,
      /not loaded anymore/,
    );
    expect(s.store.get(s.chat.id)?.messages).toEqual(before);
    await rejects(
      () => s.runner.regenerate(s.chat.id),
      400,
      /not loaded anymore/,
    );
    expect(s.store.get(s.chat.id)?.messages).toEqual(before);
    s.db.close();
  });

  test("clears the generation when the terminal store write fails", async () => {
    const s = setup();
    const finishReply = s.store.finishReply.bind(s.store);
    let fail = true;
    s.store.finishReply = (...args) => {
      if (fail) {
        fail = false;
        throw new Error("disk full");
      }
      return finishReply(...args);
    };
    const first = s.runner.send(s.chat.id, "first");
    await turn();
    await finish(s.engine.streams[0]);
    // the failed write is retried as the send's failure: the row ends as
    // an error with the store's reason, and the page gets its done
    expect(s.logs).toContain(`chat ${s.chat.id} finish failed: disk full`);
    expect(s.store.message(first.message.id)).toMatchObject({
      status: "error",
      error: "disk full",
    });
    expect(s.events.at(-1)).toMatchObject({
      kind: "done",
      message: { id: first.message.id, status: "error" },
    });
    expect(() => s.runner.send(s.chat.id, "second")).not.toThrow();
    await turn();
    s.runner.stop(s.chat.id);
    s.engine.streams[1].end();
    await turn();
    s.db.close();
  });

  test("stop and shutdown latch after a finish event until stream end", async () => {
    const stopped = setup();
    const first = stopped.runner.send(stopped.chat.id, "first");
    await turn();
    const firstStream = stopped.engine.streams[0];
    firstStream.push({ kind: "finish", reason: "stop", details: null });
    await turn();
    stopped.runner.stop(stopped.chat.id);
    expect(stopped.engine.signals[0].aborted).toBe(true);
    expect(stopped.store.message(first.message.id)).toMatchObject({
      status: "stopped",
      stats: null,
    });
    firstStream.end();
    await turn();
    stopped.db.close();

    const shutdown = setup();
    const second = shutdown.runner.send(shutdown.chat.id, "second");
    await turn();
    const secondStream = shutdown.engine.streams[0];
    secondStream.push({ kind: "finish", reason: "stop", details: null });
    await turn();
    shutdown.runner.shutdown();
    expect(shutdown.engine.signals[0].aborted).toBe(true);
    expect(shutdown.store.message(second.message.id)).toMatchObject({
      status: "interrupted",
      stats: null,
    });
    secondStream.end();
    await turn();
    shutdown.db.close();
  });

  test("remove stops a stream first and shutdown marks one interrupted", async () => {
    const s = setup();
    s.runner.send(s.chat.id, "remove me");
    await turn();
    expect(s.runner.remove(s.chat.id)).toBe(true);
    expect(s.engine.signals[0].aborted).toBe(true);
    expect(s.store.get(s.chat.id)).toBeNull();
    expect(s.events.at(-1)).toEqual({ kind: "deleted", chatId: s.chat.id });
    s.engine.streams[0].end();
    await turn();

    const next = s.runner.create({
      provider: "mlxserve",
      model: MODEL,
      systemPrompt: "",
      thinking: false,
      reasoningEffort: null,
      reasoningHistory: false,
      temperature: null,
      topP: null,
      maxTokens: null,
      search: "exa",
    });
    const reply = s.runner.send(next.id, "shutdown");
    await turn();
    s.runner.shutdown();
    expect(s.engine.signals[1].aborted).toBe(true);
    expect(s.store.message(reply.message.id)?.status).toBe("interrupted");
    s.engine.streams[1].end();
    await turn();
    s.db.close();
  });

  test("validates text, model presence, regenerate and edit targets", async () => {
    const missing = setup();
    missing.models.length = 0;
    await rejects(
      () => missing.runner.send(missing.chat.id, "hello"),
      400,
      /Qwen3.8-27B is not loaded anymore/,
    );
    missing.db.close();

    const s = setup();
    await rejects(
      () => s.runner.send(s.chat.id, "  "),
      400,
      /must not be empty/,
    );
    await rejects(
      () => s.runner.send(s.chat.id, "x".repeat(256 * 1024 + 1)),
      400,
      /at most 256 KB/,
    );
    await rejects(
      () => s.runner.regenerate(s.chat.id),
      400,
      /last message is not an assistant/,
    );
    const user = s.store.addMessage(s.chat.id, "user", { content: "x" });
    await rejects(
      () => s.runner.edit(s.chat.id, user.id + 1, "new"),
      400,
      /must be a user message/,
    );
    s.db.close();
  });

  test("boot repair turns abandoned streaming rows into interrupted", () => {
    const s = setup();
    const row = s.store.addMessage(s.chat.id, "assistant", {
      status: "streaming",
    });
    expect(s.store.repairInterrupted()).toBe(1);
    expect(s.store.message(row.id)?.status).toBe("interrupted");
    s.db.close();
  });

  test("runs a tool call then sends its assistant and tool history", async () => {
    const s = setup();
    s.runner.update(s.chat.id, { toolsOff: [] });
    s.runner.send(s.chat.id, "time");
    await turn();
    const call = clock("call_1", "Asia/Tokyo");
    await calls(s.engine.streams[0], [call]);
    expect(s.engine.requests).toHaveLength(2);
    expect(s.engine.requests[1].messages.slice(-2)).toEqual([
      { role: "assistant", content: null, toolCalls: [call] },
      {
        role: "tool",
        toolCallId: "call_1",
        content: expect.stringContaining('"timezone":"Asia/Tokyo"'),
      },
    ]);
    s.engine.streams[1].push({ kind: "content", text: "It is late." });
    await finish(s.engine.streams[1]);
    expect(s.store.get(s.chat.id)?.messages.map((row) => row.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(s.events.filter((event) => event.kind === "done")).toHaveLength(1);
    s.db.close();
  });

  test("sends earlier reasoning back only when reasoningHistory is on", async () => {
    const s = setup();
    s.runner.send(s.chat.id, "hello");
    await turn();
    s.engine.streams[0].push({ kind: "reasoning", text: "hmm" });
    s.engine.streams[0].push({ kind: "content", text: "hi" });
    await finish(s.engine.streams[0]);
    s.runner.send(s.chat.id, "again");
    await turn();
    expect(s.engine.requests[1].messages.at(-2)).toEqual({
      role: "assistant",
      content: "hi",
    });
    s.engine.streams[1].push({ kind: "content", text: "ok" });
    await finish(s.engine.streams[1]);
    s.runner.update(s.chat.id, { reasoningHistory: true });
    s.runner.send(s.chat.id, "once more");
    await turn();
    expect(s.engine.requests[2].messages.at(-4)).toEqual({
      role: "assistant",
      content: "hi",
      reasoning: "hmm",
    });
    await finish(s.engine.streams[2]);
    s.db.close();
  });

  test("starts calls in parallel and stores their rows in call order", async () => {
    const started: string[] = [];
    const releases: (() => void)[] = [];
    const s = setup([model], async (call) => {
      started.push(call.id);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { text: `result ${call.id}`, error: null };
    });
    s.runner.update(s.chat.id, { toolsOff: [] });
    s.runner.send(s.chat.id, "two clocks");
    await turn();
    const group = [clock("call_1"), clock("call_2", "Asia/Tokyo")];
    await calls(s.engine.streams[0], group);
    expect(started).toEqual(["call_1", "call_2"]);
    for (const release of releases) release();
    await turn();
    await turn();
    const tools = s.store
      .get(s.chat.id)!
      .messages.filter((row) => row.role === "tool");
    expect(tools.map((row) => [row.toolCallId, row.content])).toEqual([
      ["call_1", "result call_1"],
      ["call_2", "result call_2"],
    ]);
    s.runner.stop(s.chat.id);
    s.engine.streams[1].end();
    await turn();
    s.db.close();
  });

  test("freezes the search provider and passes its key and budget", async () => {
    const toolContexts: ToolContext[] = [];
    const s = setup([model], async (_call, ctx) => {
      toolContexts.push(ctx);
      return { text: "result", error: null };
    });
    s.runner.update(s.chat.id, { toolsOff: [], search: "firecrawl" });
    s.runner.send(s.chat.id, "search");
    await turn();
    await calls(s.engine.streams[0], [clock("call_1")]);
    const toolContext = toolContexts[0];
    expect(toolContext.search).toEqual({
      provider: "firecrawl",
      key: "firecrawl-key",
    });
    expect(toolContext.budget.searches).toBe(0);
    expect(() => s.runner.update(s.chat.id, { search: "exa" })).toThrow(
      "Model, tools and search cannot change during a send",
    );
    expect(toolContext.search.provider).toBe("firecrawl");
    s.runner.stop(s.chat.id);
    s.engine.streams[1].end();
    await turn();
    s.db.close();
  });

  test("executes calls when finish_reason is stop", async () => {
    const s = setup();
    s.runner.update(s.chat.id, { toolsOff: [] });
    s.runner.send(s.chat.id, "time");
    await turn();
    await calls(s.engine.streams[0], [clock("call_1")], "stop");
    expect(s.engine.requests).toHaveLength(2);
    expect(s.store.lastMessage(s.chat.id)).toMatchObject({
      role: "assistant",
      status: "streaming",
    });
    s.runner.stop(s.chat.id);
    s.engine.streams[1].end();
    await turn();
    s.db.close();
  });

  test("stores length-finished partial calls without running them", async () => {
    let ran = false;
    const s = setup([model], async () => {
      ran = true;
      return { text: "unexpected", error: null };
    });
    s.runner.update(s.chat.id, { toolsOff: [] });
    const sent = s.runner.send(s.chat.id, "time");
    await turn();
    const partial = {
      id: "call_1",
      name: "get_current_time",
      arguments: '{"timezone":',
    };
    await calls(s.engine.streams[0], [partial], "length");
    expect(ran).toBe(false);
    expect(s.engine.requests).toHaveLength(1);
    expect(s.store.message(sent.message.id)).toMatchObject({
      status: "done",
      finishReason: "length",
      toolCalls: [partial],
    });
    expect(
      s.store.get(s.chat.id)?.messages.filter((row) => row.role === "tool"),
    ).toEqual([]);
    // the cut row stays in the transcript and leaves the wire: a call
    // without a result would be a malformed history (gemma 4 looped on a
    // websearch call twice in a row on the Studio, 2026-09-10, and the
    // first row vanished at the next send)
    s.runner.send(s.chat.id, "again");
    await turn();
    expect(s.store.get(s.chat.id)?.messages.map((row) => row.id)).toContain(
      sent.message.id,
    );
    expect(s.engine.requests[1].messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "user",
    ]);
    expect(s.logs.some((line) => line.includes("malformed"))).toBe(false);
    s.runner.stop(s.chat.id);
    s.engine.streams[1].end();
    await turn();
    s.db.close();
  });

  test("unknown tool, bad JSON and empty arguments become tool results", async () => {
    const cases: [ToolCall, RegExp][] = [
      [
        { id: "unknown", name: "missing", arguments: "{}" },
        /tool "missing" not found/,
      ],
      [
        { id: "bad", name: "get_current_time", arguments: "{" },
        /invalid JSON arguments/,
      ],
      [
        { id: "empty", name: "get_current_time", arguments: "" },
        /timezone must be a non-empty string/,
      ],
    ];
    for (const [call, expected] of cases) {
      const s = setup();
      s.runner.update(s.chat.id, { toolsOff: [] });
      s.runner.send(s.chat.id, "time");
      await turn();
      await calls(s.engine.streams[0], [call]);
      const tool = s.store
        .get(s.chat.id)!
        .messages.find((row) => row.role === "tool")!;
      expect(tool.status).toBe("error");
      expect(tool.content).toMatch(expected);
      expect(s.engine.requests).toHaveLength(2);
      s.runner.stop(s.chat.id);
      s.engine.streams[1].end();
      await turn();
      s.db.close();
    }
  });

  test("stop aborts a waiting tool and completes its group", async () => {
    const s = setup(
      [model],
      (_call, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener(
            "abort",
            () => resolve({ text: "aborted", error: "aborted" }),
            { once: true },
          );
        }),
    );
    s.runner.update(s.chat.id, { toolsOff: [] });
    s.runner.send(s.chat.id, "wait");
    await turn();
    await calls(s.engine.streams[0], [clock("call_1")]);
    expect(s.store.lastMessage(s.chat.id)?.status).toBe("running");
    s.runner.stop(s.chat.id);
    await turn();
    const rows = s.store.get(s.chat.id)!.messages;
    expect(rows.at(-1)).toMatchObject({
      role: "tool",
      status: "stopped",
      content: "[Tool execution was interrupted]",
    });
    expect(rows[1]).toMatchObject({
      status: "done",
      toolCalls: [clock("call_1")],
    });
    s.db.close();
  });

  // Synthetic fault injection from the backend reproduction, not a
  // recording from the preview: SQLite rejects only one tool transition.
  test("fatal tool writes preserve the group and drain every aborted sibling", async () => {
    for (const transition of ["running", "done"]) {
      const first = Promise.withResolvers<{
        text: string;
        error: string | null;
      }>();
      const last = Promise.withResolvers<{
        text: string;
        error: string | null;
      }>();
      const signals: AbortSignal[] = [];
      const s = setup([model], async (call, ctx) => {
        signals.push(ctx.signal);
        if (call.id === "waiting_1") return first.promise;
        if (call.id === "waiting_2") return last.promise;
        return { text: `result ${call.id}`, error: null };
      });
      try {
        s.db.run(`CREATE TEMP TRIGGER injected_tool_failure
          BEFORE UPDATE OF status ON messages
          WHEN OLD.role = 'tool' AND OLD.tool_call_id = 'failure'
            AND NEW.status = '${transition}'
          BEGIN SELECT RAISE(ABORT, 'injected tool write failure'); END`);
        s.runner.update(s.chat.id, { toolsOff: [] });
        const sent = s.runner.send(s.chat.id, "clocks");
        await turn();
        const group = [
          clock("success"),
          clock("failure"),
          clock("waiting_1"),
          clock("waiting_2"),
        ];
        const stats = {
          promptTokens: 12,
          cachedTokens: 3,
          generated: 4,
          prefillMs: 10,
          decodeMs: 20,
          tokenizeMs: 1,
          cost: null,
        };
        s.engine.streams[0].push({ kind: "content", text: "Checking." });
        s.engine.streams[0].push({ kind: "reasoning", text: "Use clocks." });
        s.engine.streams[0].push({ kind: "usage", stats });
        await calls(s.engine.streams[0], group);
        expect(running(s.runner)).toBeNull();
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(s.engine.signals[0].aborted).toBe(true);
        expect(s.engine.requests).toHaveLength(1);
        expect(s.store.message(sent.message.id)).toMatchObject({
          status: "error",
          error: "injected tool write failure",
          content: "Checking.",
          reasoning: "Use clocks.",
          toolCalls: group,
          finishReason: "tool_calls",
          stats,
        });
        const rows = s.store.get(s.chat.id)!.messages;
        expect(rows.slice(2).map((row) => row.status)).toEqual([
          "done",
          "interrupted",
          "interrupted",
          "interrupted",
        ]);
        expect(rows[2].content).toBe("result success");
        expect(
          rows
            .slice(3)
            .every(
              (row) =>
                row.content === "[Tool execution was interrupted]" &&
                row.finishedAt !== null,
            ),
        ).toBe(true);
        expect(s.events.filter((event) => event.kind === "done")).toMatchObject(
          [
            {
              message: {
                status: "error",
                error: "injected tool write failure",
              },
            },
          ],
        );
        expect(s.logs).toContain(
          `chat ${s.chat.id} error: injected tool write failure`,
        );
        const terminalEvents = s.events.length;
        const writeTool = s.store.writeTool.bind(s.store);
        let lateWrites = 0;
        s.store.writeTool = (...args) => {
          lateWrites++;
          return writeTool(...args);
        };
        s.runner.stop(s.chat.id);
        s.runner.shutdown();
        await rejects(
          () => s.runner.send(s.chat.id, "too soon"),
          409,
          /Still cancelling/,
        );
        first.resolve({ text: "late first result", error: null });
        await turn();
        await rejects(
          () => s.runner.send(s.chat.id, "still too soon"),
          409,
          /Still cancelling/,
        );
        last.resolve({ text: "late last result", error: null });
        await turn();
        expect(s.events).toHaveLength(terminalEvents);
        expect(s.store.get(s.chat.id)!.messages).toEqual(rows);
        expect(lateWrites).toBe(0);
        const next = s.runner.send(s.chat.id, "after drain");
        await turn();
        expect(running(s.runner)?.messageId).toBe(next.message.id);
        expect(s.engine.requests[1].messages.slice(2, 7)).toEqual([
          { role: "assistant", content: "Checking.", toolCalls: group },
          { role: "tool", toolCallId: "success", content: "result success" },
          ...group.slice(1).map((call) => ({
            role: "tool" as const,
            toolCallId: call.id,
            content: "[Tool execution was interrupted]",
          })),
        ]);
        await finish(s.engine.streams[1]);
      } finally {
        first.resolve({ text: "cleanup", error: null });
        last.resolve({ text: "cleanup", error: null });
        s.runner.shutdown();
        for (const stream of s.engine.streams) stream.end();
        await turn();
        s.db.close();
      }
    }
  });

  test("deleting a failed chat retains the lock until its tools drain", async () => {
    const failure = Promise.withResolvers<never>();
    const waiting = Promise.withResolvers<{ text: string; error: null }>();
    const s = setup([model], async (call) =>
      call.id === "failure" ? failure.promise : waiting.promise,
    );
    try {
      s.runner.send(s.chat.id, "old");
      await turn();
      await calls(s.engine.streams[0], [clock("failure"), clock("waiting")]);
      failure.reject(new Error("executor rejected"));
      await turn();
      expect(s.engine.signals[0].aborted).toBe(true);
      expect(s.events.filter((event) => event.kind === "done")).toHaveLength(1);
      expect(s.runner.remove(s.chat.id)).toBe(true);
      expect(s.runner.get(s.chat.id)).toBeNull();
      const nextChat = s.runner.create({ ...s.chat });
      const beforeDrain = s.events.length;
      await rejects(
        () => s.runner.send(nextChat.id, "too soon"),
        409,
        /Still cancelling/,
      );
      s.runner.stop(s.chat.id);
      s.runner.shutdown();
      waiting.resolve({ text: "discarded result", error: null });
      await turn();
      expect(s.events).toHaveLength(beforeDrain);
      const next = s.runner.send(nextChat.id, "replacement");
      await turn();
      await turn();
      expect(running(s.runner)).toEqual({
        chatId: nextChat.id,
        messageId: next.message.id,
      });
      await finish(s.engine.streams[1]);
    } finally {
      waiting.resolve({ text: "cleanup", error: null });
      failure.reject(new Error("cleanup"));
      s.runner.shutdown();
      for (const stream of s.engine.streams) stream.end();
      await turn();
      s.db.close();
    }
  });

  test("stopped tools that reject early still drain before another send", async () => {
    for (const action of ["stop", "remove", "shutdown"] as const) {
      const rejected = Promise.withResolvers<never>();
      const pending = Promise.withResolvers<{ text: string; error: null }>();
      const s = setup([model], async (call) =>
        call.id === "rejected" ? rejected.promise : pending.promise,
      );
      try {
        s.runner.send(s.chat.id, "old");
        await turn();
        await calls(s.engine.streams[0], [clock("rejected"), clock("pending")]);
        if (action === "shutdown") s.runner.shutdown();
        else s.runner[action](s.chat.id);
        expect(s.engine.signals[0].aborted).toBe(true);
        const events = s.events.length;
        rejected.reject(new Error("late abort rejection"));
        await turn();
        const next = s.runner.create({ ...s.chat });
        await rejects(
          () => s.runner.send(next.id, "too soon"),
          409,
          /Still cancelling/,
        );
        pending.resolve({ text: "late result", error: null });
        await turn();
        expect(s.events).toHaveLength(events + 1);
        expect(s.events.filter((event) => event.kind === "done")).toHaveLength(
          1,
        );
        s.runner.send(next.id, "after drain");
        await turn();
        await finish(s.engine.streams[1]);
      } finally {
        rejected.reject(new Error("cleanup"));
        pending.resolve({ text: "cleanup", error: null });
        s.runner.shutdown();
        for (const stream of s.engine.streams) stream.end();
        await turn();
        s.db.close();
      }
    }
  });

  test("terminal stop and shutdown attempt every interruption despite write failures", async () => {
    for (const action of ["stop", "shutdown"] as const) {
      const pending = Promise.withResolvers<{ text: string; error: null }>();
      const s = setup([model], async () => pending.promise);
      try {
        s.db.run(`CREATE TEMP TRIGGER injected_terminal_failure
          BEFORE UPDATE OF status ON messages
          WHEN OLD.role = 'tool'
            AND OLD.tool_call_id IN ('failure_1', 'failure_2')
            AND NEW.status IN ('stopped', 'interrupted')
          BEGIN SELECT RAISE(ABORT, 'terminal write failed'); END`);
        s.runner.send(s.chat.id, "clocks");
        await turn();
        await calls(s.engine.streams[0], [
          clock("failure_1"),
          clock("failure_2"),
          clock("success"),
        ]);
        if (action === "stop") s.runner.stop(s.chat.id);
        else s.runner.shutdown();
        expect(running(s.runner)).toBeNull();
        expect(s.engine.signals[0].aborted).toBe(true);
        expect(s.engine.requests).toHaveLength(1);
        const rows = s.store.get(s.chat.id)!.messages;
        expect(rows.slice(2).map((row) => row.status)).toEqual([
          "running",
          "running",
          action === "stop" ? "stopped" : "interrupted",
        ]);
        expect(rows.at(-1)).toMatchObject({
          content: "[Tool execution was interrupted]",
          finishedAt: 1000,
        });
        for (const id of ["failure_1", "failure_2"]) {
          expect(s.logs).toContain(
            `chat ${s.chat.id} tool ${id} interrupt failed: terminal write failed`,
          );
        }
        expect(s.events.filter((event) => event.kind === "done")).toHaveLength(
          1,
        );
        expect(s.events.filter((event) => event.kind === "error")).toHaveLength(
          0,
        );
        const terminalEvents = s.events.length;
        await rejects(
          () => s.runner.send(s.chat.id, "too soon"),
          409,
          /Still cancelling/,
        );
        pending.resolve({ text: "late result", error: null });
        await turn();
        expect(s.store.get(s.chat.id)!.messages).toEqual(rows);
        expect(s.events).toHaveLength(terminalEvents);
        expect(s.engine.requests).toHaveLength(1);
      } finally {
        pending.resolve({ text: "cleanup", error: null });
        s.runner.shutdown();
        for (const stream of s.engine.streams) stream.end();
        await turn();
        s.db.close();
      }
    }
  });

  test("completed send cleanup cannot clear a replacement from its done listener", async () => {
    const s = setup();
    const replacements: number[] = [];
    const unsubscribe = s.runner.onEvent((event) => {
      if (event.kind !== "done" || replacements.length > 0) return;
      replacements.push(s.runner.send(s.chat.id, "replacement").message.id);
    });
    s.runner.send(s.chat.id, "first");
    await turn();
    await finish(s.engine.streams[0]);
    expect(replacements).toHaveLength(1);
    expect(running(s.runner)?.messageId).toBe(replacements[0]);
    unsubscribe();
    await finish(s.engine.streams[1]);
    s.db.close();
  });

  test("failure starting the answer round keeps a completed tool result", async () => {
    const s = setup([model], async () => ({
      text: "saved result",
      error: null,
    }));
    const addMessage = s.store.addMessage.bind(s.store);
    let rejectAnswer = true;
    s.store.addMessage = (...args) => {
      if (
        args[1] === "assistant" &&
        s.engine.requests.length === 1 &&
        rejectAnswer
      ) {
        rejectAnswer = false;
        throw new Error("answer row insert failed");
      }
      return addMessage(...args);
    };
    const sent = s.runner.send(s.chat.id, "clock");
    await turn();
    await calls(s.engine.streams[0], [clock("call_1")]);
    expect(s.store.message(sent.message.id)).toMatchObject({
      status: "error",
      error: "answer row insert failed",
      toolCalls: [clock("call_1")],
    });
    expect(s.store.lastMessage(s.chat.id)).toMatchObject({
      role: "tool",
      status: "done",
      content: "saved result",
    });
    expect(s.events.filter((event) => event.kind === "done")).toHaveLength(1);
    expect(s.engine.signals[0].aborted).toBe(true);
    expect(running(s.runner)).toBeNull();
    s.db.close();
  });

  test("logs the original failure before secondary finalization failures", async () => {
    for (const blocked of ["assistant", "tool"]) {
      const s = setup([model], async () => {
        throw new Error("original executor failure");
      });
      const failToolGroup = s.store.failToolGroup.bind(s.store);
      s.store.failToolGroup = (...args) => {
        expect(s.logs).toContain(
          `chat ${s.chat.id} error: original executor failure`,
        );
        return failToolGroup(...args);
      };
      s.db.run(`CREATE TEMP TRIGGER injected_secondary_failure
        BEFORE UPDATE OF status ON messages
        WHEN OLD.role = '${blocked}'
          AND NEW.status IN ('error', 'interrupted')
          AND (OLD.role = 'assistant' OR OLD.tool_call_id = 'call_1')
        BEGIN SELECT RAISE(ABORT, 'secondary write failure'); END`);
      const sent = s.runner.send(s.chat.id, "clock");
      await turn();
      await calls(s.engine.streams[0], [clock("call_1"), clock("call_2")]);
      expect(s.logs[2]).toContain("error: original executor failure");
      expect(
        s.logs.some((line) => line.includes("secondary write failure")),
      ).toBe(true);
      expect(s.engine.signals[0].aborted).toBe(true);
      expect(running(s.runner)).toBeNull();
      expect(s.store.lastMessage(s.chat.id)?.status).toBe("interrupted");
      expect(s.events.filter((event) => event.kind === "done")).toHaveLength(
        blocked === "assistant" ? 0 : 1,
      );
      const errors = s.events.filter((event) => event.kind === "error");
      expect(errors).toHaveLength(blocked === "assistant" ? 1 : 0);
      if (blocked === "assistant") {
        expect(errors[0]).toMatchObject({
          chatId: s.chat.id,
          firstMessageId: sent.message.id,
          messageId: sent.message.id,
          error: "original executor failure (reply could not be saved)",
        });
      }
      let page = stateOf(s.chat);
      for (const event of s.events) {
        page = applyEvent(page, event, 1000).state;
      }
      expect([...page.ended]).toEqual([sent.message.id]);
      expect(
        page.chat.messages.find((m) => m.id === sent.message.id),
      ).toMatchObject({
        status: "error",
        error:
          blocked === "assistant"
            ? "original executor failure (reply could not be saved)"
            : "original executor failure",
      });
      expect(s.store.message(sent.message.id)?.error).toBe(
        blocked === "assistant" ? null : "original executor failure",
      );
      s.db.run("DROP TRIGGER injected_secondary_failure");
      s.runner.send(s.chat.id, "next");
      await turn();
      await finish(s.engine.streams[1]);
      s.db.close();
    }
  });

  test("uses repaired missing tool rows in the next valid request", async () => {
    const s = setup();
    const firstUser = s.store.addMessage(s.chat.id, "user", { content: "old" });
    const call = clock("call_repaired");
    s.store.addMessage(s.chat.id, "assistant", {
      status: "done",
      toolCalls: [call],
    });
    expect(s.store.repairAtBoot(900)).toBe(1);
    s.runner.send(s.chat.id, "new");
    await turn();
    expect(s.engine.requests[0].messages).toEqual(
      expect.arrayContaining([
        { role: "user", content: firstUser.content },
        { role: "assistant", content: null, toolCalls: [call] },
        {
          role: "tool",
          toolCallId: call.id,
          content: "[Tool execution was interrupted]",
        },
      ]),
    );
    s.runner.stop(s.chat.id);
    s.engine.streams[0].end();
    await turn();
    s.db.close();
  });

  test("regenerate removes every tool round after the last user", async () => {
    const s = setup();
    s.runner.update(s.chat.id, { toolsOff: [] });
    const first = s.runner.send(s.chat.id, "time");
    await turn();
    await calls(s.engine.streams[0], [clock("call_1")]);
    s.engine.streams[1].push({ kind: "content", text: "answer" });
    await finish(s.engine.streams[1]);
    const regenerated = s.runner.regenerate(s.chat.id);
    expect(regenerated.user.id).toBe(first.user.id);
    expect(s.store.get(s.chat.id)?.messages.map((row) => row.role)).toEqual([
      "user",
      "assistant",
    ]);
    s.runner.stop(s.chat.id);
    await turn();
    s.engine.streams[2].end();
    await turn();
    s.db.close();
  });

  test("stops three identical call sets as a doom loop", async () => {
    const s = setup();
    s.runner.update(s.chat.id, { toolsOff: [] });
    s.runner.send(s.chat.id, "loop");
    await turn();
    for (let round = 0; round < 3; round++) {
      await calls(s.engine.streams[round], [clock(`call_${round}`)]);
    }
    expect(s.engine.requests).toHaveLength(3);
    const rows = s.store.get(s.chat.id)!.messages;
    expect(rows.filter((row) => row.role === "tool").at(-1)).toMatchObject({
      status: "stopped",
      content: "[Tool execution was interrupted]",
    });
    expect(rows.filter((row) => row.role === "assistant").at(-1)).toMatchObject(
      {
        finishReason: "tool_loop",
      },
    );
    expect(s.logs).toContain(`chat ${s.chat.id} tool loop`);
    s.db.close();
  });

  test("keeps the tools and nudges on the last tool result on round eight", async () => {
    const s = setup();
    s.runner.update(s.chat.id, { toolsOff: [] });
    s.runner.send(s.chat.id, "keep going");
    await turn();
    for (let round = 0; round < 7; round++) {
      await calls(s.engine.streams[round], [
        clock(`call_${round}`, `Etc/GMT${round === 0 ? "" : `+${round}`}`),
      ]);
    }
    expect(s.engine.requests).toHaveLength(8);
    // the tools stay so the engine parses a call the model makes anyway
    expect(s.engine.requests[7].tools).toHaveLength(3);
    // the system prompt is the cached prefix and must not change
    expect(s.engine.requests[7].messages[0]).toEqual(
      s.engine.requests[6].messages[0],
    );
    const tail = s.engine.requests[7].messages.at(-1)!;
    expect(tail).toMatchObject({ role: "tool", toolCallId: "call_6" });
    expect(tail.content).toStartWith('{"timezone":"Etc/GMT+6"');
    expect(tail.content).toEndWith(`\n\n${EXHAUSTED}`);
    expect(s.engine.requests[6].messages.at(-1)?.content).not.toContain(
      "exhausted",
    );
    s.engine.streams[7].push({ kind: "content", text: "final" });
    await finish(s.engine.streams[7]);
    expect(s.store.get(s.chat.id)!.messages.at(-1)).toMatchObject({
      role: "assistant",
      status: "done",
      content: "final",
      finishReason: "stop",
    });
    s.db.close();
  });

  test("a call on round eight ends the round as tool_limit and an answer round follows", async () => {
    const s = setup();
    s.runner.update(s.chat.id, { toolsOff: [] });
    s.runner.send(s.chat.id, "keep going");
    await turn();
    for (let round = 0; round < 8; round++) {
      await calls(s.engine.streams[round], [
        clock(`call_${round}`, `Etc/GMT${round === 0 ? "" : `+${round}`}`),
      ]);
    }
    expect(s.engine.requests).toHaveLength(9);
    const answer = s.engine.requests[8];
    // the tools stay: the template renders them at the top of the context
    expect(answer.tools).toHaveLength(3);
    expect(answer.messages[0]).toEqual(s.engine.requests[7].messages[0]);
    // the unrun call and its interrupted result are in the context, then
    // the nudge
    expect(answer.messages.slice(-2)).toEqual([
      {
        role: "assistant",
        content: null,
        toolCalls: [clock("call_7", "Etc/GMT+7")],
      },
      {
        role: "tool",
        toolCallId: "call_7",
        content: `[Tool execution was interrupted]\n\n${EXHAUSTED}`,
      },
    ]);
    expect(s.logs).toContain(`chat ${s.chat.id} tool limit`);
    expect(s.logs).toContain(`chat ${s.chat.id} answer round`);
    expect(running(s.runner)).toEqual({
      chatId: s.chat.id,
      messageId: s.store.get(s.chat.id)!.messages.at(-1)!.id,
    });
    s.engine.streams[8].push({ kind: "content", text: "the answer" });
    await finish(s.engine.streams[8]);
    const rows = s.store.get(s.chat.id)!.messages;
    expect(rows.slice(-3)).toMatchObject([
      { role: "assistant", finishReason: "tool_limit", status: "done" },
      { role: "tool", status: "stopped" },
      {
        role: "assistant",
        status: "done",
        content: "the answer",
        finishReason: "stop",
      },
    ]);
    expect(s.events.at(-1)).toMatchObject({
      kind: "done",
      message: { id: rows.at(-1)!.id, content: "the answer" },
    });
    expect(running(s.runner)).toBeNull();
    s.db.close();
  });

  test("too many calls in one round ends it as tool_limit and answers", async () => {
    const s = setup();
    s.runner.update(s.chat.id, { toolsOff: [] });
    s.runner.send(s.chat.id, "all the zones");
    await turn();
    await calls(
      s.engine.streams[0],
      Array.from({ length: 9 }, (_, i) => clock(`call_${i}`, `Etc/GMT+${i}`)),
    );
    expect(s.engine.requests).toHaveLength(2);
    expect(s.engine.requests[1].tools).toHaveLength(3);
    expect(s.engine.requests[1].messages.at(-1)?.content).toEndWith(EXHAUSTED);
    const rows = s.store.get(s.chat.id)!.messages;
    expect(rows[1]).toMatchObject({ finishReason: "tool_limit" });
    expect(rows.filter((row) => row.role === "tool")).toHaveLength(9);
    expect(
      rows
        .filter((row) => row.role === "tool")
        .every((row) => row.status === "stopped"),
    ).toBe(true);
    s.engine.streams[1].push({ kind: "content", text: "nine is too many" });
    await finish(s.engine.streams[1]);
    expect(s.store.get(s.chat.id)!.messages.at(-1)).toMatchObject({
      content: "nine is too many",
      finishReason: "stop",
    });
    s.db.close();
  });

  for (const reason of ["tool_limit", "tool_loop"]) {
    for (const failureCount of [1, 2]) {
      test(`${reason} interruption fails the send after ${failureCount} stopped write failures`, async () => {
        const executed: string[] = [];
        const s = setup([model], async (call) => {
          executed.push(call.id);
          return { text: `result ${call.id}`, error: null };
        });
        try {
          const rounds = reason === "tool_limit" ? 1 : 3;
          const group = Array.from(
            { length: reason === "tool_limit" ? 9 : 4 },
            (_, index) => clock(`last_${index}`, `Etc/GMT+${index}`),
          );
          const failed = group.slice(1, 1 + failureCount);
          for (const call of failed) {
            s.db.run(`CREATE TEMP TRIGGER injected_${call.id}
              BEFORE UPDATE OF status ON messages
              WHEN OLD.role = 'tool' AND OLD.tool_call_id = '${call.id}'
                AND NEW.status = 'stopped'
              BEGIN SELECT RAISE(ABORT, 'stopped write ${call.id} failed'); END`);
          }
          s.runner.update(s.chat.id, { toolsOff: [] });
          s.runner.send(s.chat.id, "clocks");
          await turn();
          for (let round = 0; round < rounds - 1; round++) {
            await calls(
              s.engine.streams[round],
              group.map((call, index) => ({
                ...call,
                id: `round_${round}_${index}`,
              })),
            );
          }
          const messageId = running(s.runner)!.messageId;
          s.engine.streams[rounds - 1].push({
            kind: "content",
            text: "Checking.",
          });
          await calls(s.engine.streams[rounds - 1], group);
          const error = `stopped write ${failed[0].id} failed`;
          expect(running(s.runner)).toBeNull();
          expect(s.engine.requests).toHaveLength(rounds);
          expect(executed).toHaveLength((rounds - 1) * group.length);
          expect(s.engine.signals.every((signal) => signal.aborted)).toBe(true);
          expect(s.store.message(messageId)).toMatchObject({
            status: "error",
            error,
            content: "Checking.",
            finishReason: reason,
            toolCalls: group,
          });
          expect(
            s.events.filter((event) => event.kind === "done"),
          ).toMatchObject([
            { message: { id: messageId, status: "error", error } },
          ]);
          expect(
            s.events.filter((event) => event.kind === "error"),
          ).toHaveLength(0);
          const rows = s.store
            .get(s.chat.id)!
            .messages.filter((row) => row.id > messageId);
          expect(rows).toHaveLength(group.length);
          expect(rows.map((row) => row.status)).toEqual(
            group.map((call) =>
              failed.includes(call) ? "interrupted" : "stopped",
            ),
          );
          expect(
            rows.every(
              (row) =>
                row.content === "[Tool execution was interrupted]" &&
                row.finishedAt !== null,
            ),
          ).toBe(true);
          for (const call of failed) {
            expect(s.logs).toContain(
              `chat ${s.chat.id} tool ${call.id} interrupt failed: stopped write ${call.id} failed`,
            );
          }
          expect(s.logs).toContain(`chat ${s.chat.id} error: ${error}`);
          expect(s.logs).not.toContain(`chat ${s.chat.id} answer round`);
          await turn();
          expect(s.engine.requests).toHaveLength(rounds);
          for (const call of failed) {
            s.db.run(`DROP TRIGGER injected_${call.id}`);
          }
          const next = s.runner.send(s.chat.id, "after recovery");
          await turn();
          expect(running(s.runner)?.messageId).toBe(next.message.id);
          expect(s.engine.requests).toHaveLength(rounds + 1);
          expect(
            s.engine.requests[rounds].messages.slice(-group.length - 2, -1),
          ).toEqual([
            { role: "assistant", content: "Checking.", toolCalls: group },
            ...group.map<ChatMessageIn>((call) => ({
              role: "tool",
              toolCallId: call.id,
              content: "[Tool execution was interrupted]",
            })),
          ]);
          s.engine.streams[rounds].push({
            kind: "content",
            text: "Recovered.",
          });
          await finish(s.engine.streams[rounds]);
          expect(s.store.message(next.message.id)).toMatchObject({
            status: "done",
            content: "Recovered.",
          });
          expect(running(s.runner)).toBeNull();
        } finally {
          s.runner.shutdown();
          for (const stream of s.engine.streams) stream.end();
          await turn();
          s.db.close();
        }
      });
    }
  }

  test("a call in the answer round ends the send as tool_limit", async () => {
    const s = setup();
    s.runner.update(s.chat.id, { toolsOff: [] });
    s.runner.send(s.chat.id, "again");
    await turn();
    await calls(
      s.engine.streams[0],
      Array.from({ length: 9 }, (_, i) => clock(`call_${i}`, `Etc/GMT+${i}`)),
    );
    await calls(s.engine.streams[1], [clock("call_more")]);
    expect(s.engine.requests).toHaveLength(2);
    expect(running(s.runner)).toBeNull();
    const last = s.store.get(s.chat.id)!.messages.at(-1)!;
    expect(last).toMatchObject({
      role: "assistant",
      status: "done",
      finishReason: "tool_limit",
      toolCalls: [clock("call_more")],
    });
    expect(s.events.at(-1)).toMatchObject({
      kind: "done",
      message: { id: last.id },
    });
    // the unrun call of the answer round is not sent back
    s.runner.send(s.chat.id, "again");
    await turn();
    // the round is empty without its call, so it leaves the wire whole
    const next = s.engine.requests.at(-1)!.messages;
    expect(JSON.stringify(next)).not.toContain("call_more");
    expect(JSON.stringify(next)).toContain("call_8");
    expect(s.store.message(last.id)).not.toBeNull();
    s.runner.stop(s.chat.id);
    s.engine.streams.at(-1)!.end();
    await turn();
    s.db.close();
  });

  test("adds the date with the tools off and with them on", async () => {
    const off = setup();
    off.runner.update(off.chat.id, { systemPrompt: "" });
    off.runner.send(off.chat.id, "off");
    await turn();
    expect(off.engine.requests[0]).not.toHaveProperty("tools");
    expect(off.engine.requests[0].messages[0]).toEqual({
      role: "system",
      content: "Today's date: Thursday, 1970-01-01",
    });
    off.runner.stop(off.chat.id);
    off.engine.streams[0].end();
    await turn();
    off.db.close();

    const on = setup();
    on.runner.update(on.chat.id, { toolsOff: [] });
    on.runner.send(on.chat.id, "on");
    await turn();
    expect(on.engine.requests[0].tools?.map((tool) => tool.name)).toEqual([
      "get_current_time",
      "webfetch",
      "websearch",
    ]);
    expect(on.engine.requests[0].messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Today's date: Thursday, 1970-01-01"),
    });
    on.runner.stop(on.chat.id);
    on.engine.streams[0].end();
    await turn();
    on.db.close();
  });

  test("compact runs a summary round and the next request starts from it", async () => {
    const s = setup();
    await rejects(
      () => s.runner.compact(s.chat.id),
      400,
      /Nothing to summarize/,
    );
    s.runner.send(s.chat.id, "first");
    await turn();
    s.engine.streams[0].push({ kind: "content", text: "one" });
    await finish(s.engine.streams[0]);

    const started = s.runner.compact(s.chat.id);
    expect(started.message.role).toBe("summary");
    expect(started.message.status).toBe("streaming");
    expect(running(s.runner)).toEqual({
      chatId: s.chat.id,
      messageId: started.message.id,
    });
    await turn();
    const request = s.engine.requests[1];
    expect(request).not.toHaveProperty("tools");
    expect(request.thinking).toBe(false);
    // a quarter of the test model's window of 1000
    expect(request.maxTokens).toBe(250);
    expect(request.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(request.messages.at(-1)?.content).toMatch(
      /^Summarize the conversation/,
    );
    s.engine.streams[1].push({ kind: "content", text: "## Goal\n- one" });
    await finish(s.engine.streams[1]);
    const summary = s.store.get(s.chat.id)!.messages.at(-1)!;
    expect(summary.role).toBe("summary");
    expect(summary.status).toBe("done");
    expect(summary.html).toContain("<h2");
    expect(s.events.filter((e) => e.kind === "started")).toMatchObject([
      { user: expect.any(Object) },
      { user: null, message: { id: started.message.id } },
    ]);
    expect(s.events.filter((e) => e.kind === "done").at(-1)).toMatchObject({
      message: { id: summary.id, role: "summary" },
    });
    // a second compact right away has nothing new to summarize
    await rejects(
      () => s.runner.compact(s.chat.id),
      400,
      /Nothing to summarize/,
    );

    s.runner.send(s.chat.id, "second");
    await turn();
    expect(s.engine.requests[2].messages).toEqual([
      { role: "system", content: expect.stringContaining("be concise") },
      {
        role: "user",
        content: expect.stringContaining(
          "the earlier messages were dropped:\n\n## Goal\n- one",
        ),
      },
      { role: "user", content: "second" },
    ]);
    s.runner.stop(s.chat.id);
    s.engine.streams[2].end();
    await turn();
    s.db.close();
  });

  test("a failed or stopped summary is skipped by the next request", async () => {
    const s = setup();
    s.runner.send(s.chat.id, "first");
    await turn();
    s.engine.streams[0].push({ kind: "content", text: "one" });
    await finish(s.engine.streams[0]);

    s.runner.compact(s.chat.id);
    await turn();
    await finish(s.engine.streams[1]);
    const empty = s.store.get(s.chat.id)!.messages.at(-1)!;
    expect(empty).toMatchObject({
      role: "summary",
      status: "error",
      error: "the summary came back empty",
    });
    expect(running(s.runner)).toBeNull();

    s.runner.compact(s.chat.id);
    await turn();
    s.engine.streams[2].push({ kind: "content", text: "half" });
    await turn();
    s.runner.stop(s.chat.id);
    s.engine.streams[2].end();
    await turn();
    expect(s.store.get(s.chat.id)!.messages.at(-1)).toMatchObject({
      role: "summary",
      status: "stopped",
      content: "half",
    });

    s.runner.send(s.chat.id, "second");
    await turn();
    expect(s.engine.requests[3].messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    s.runner.stop(s.chat.id);
    s.engine.streams[3].end();
    await turn();
    s.db.close();
  });

  test("a reply that fills the window is followed by a summary round", async () => {
    const wide: ModelInfo = { ...model, id: "org/wide", contextLength: 30_000 };
    const s = setup([model, wide]);
    s.runner.update(s.chat.id, { model: wide.id });
    s.runner.send(s.chat.id, "big");
    await turn();
    s.engine.streams[0].push({ kind: "content", text: "answer" });
    s.engine.streams[0].push({ kind: "finish", reason: "stop", details: null });
    s.engine.streams[0].push({
      kind: "usage",
      stats: {
        promptTokens: 22_400,
        cachedTokens: 0,
        generated: 100,
        prefillMs: 1,
        decodeMs: 1,
        tokenizeMs: 1,
        cost: null,
      },
    });
    s.engine.streams[0].end();
    await turn();
    await turn();
    // the reply is done and published, the send goes on with the summary
    expect(s.events.filter((e) => e.kind === "done")).toHaveLength(0);
    const rows = s.store.get(s.chat.id)!.messages;
    expect(rows.map((row) => [row.role, row.status])).toEqual([
      ["user", "done"],
      ["assistant", "done"],
      ["summary", "streaming"],
    ]);
    expect(s.engine.requests[1].messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(s.engine.requests[1].thinking).toBe(false);
    s.engine.streams[1].push({ kind: "content", text: "- big" });
    await finish(s.engine.streams[1]);
    expect(s.events.filter((e) => e.kind === "done")).toMatchObject([
      { message: { role: "summary", status: "done" } },
    ]);
    expect(
      s.logs.some((line) => line.includes("22500 tokens, summarizing")),
    ).toBe(true);
    // the default test model has a window of 1000 and the replies use 13
    const small = setup();
    small.runner.send(small.chat.id, "big");
    await turn();
    small.engine.streams[0].push({ kind: "content", text: "answer" });
    await finish(small.engine.streams[0]);
    expect(
      small.store.get(small.chat.id)!.messages.map((row) => row.role),
    ).toEqual(["user", "assistant"]);
    small.db.close();
    s.db.close();

    // a window under the reserve keeps a quarter of itself: gemma 4 on
    // the Studio loads with 19,456, so 14,592 is the line and the summary
    // is capped at what is left
    const gemma: ModelInfo = {
      ...model,
      id: "org/gemma",
      contextLength: 19_456,
    };
    const g = setup([model, gemma]);
    g.runner.update(g.chat.id, { model: gemma.id });
    g.runner.send(g.chat.id, "big");
    await turn();
    g.engine.streams[0].push({ kind: "content", text: "answer" });
    g.engine.streams[0].push({ kind: "finish", reason: "stop", details: null });
    g.engine.streams[0].push({
      kind: "usage",
      stats: {
        promptTokens: 14_500,
        cachedTokens: 0,
        generated: 92,
        prefillMs: 1,
        decodeMs: 1,
        tokenizeMs: 1,
        cost: null,
      },
    });
    g.engine.streams[0].end();
    await turn();
    await turn();
    expect(g.engine.requests).toHaveLength(2);
    expect(g.engine.requests[1].maxTokens).toBe(4096);
    expect(
      g.store.get(g.chat.id)!.messages.map((row) => [row.role, row.status]),
    ).toEqual([
      ["user", "done"],
      ["assistant", "done"],
      ["summary", "streaming"],
    ]);
    g.runner.stop(g.chat.id);
    g.engine.streams[1].end();
    await turn();
    g.db.close();
  });
});

// the registry's view of a send, published on every change of the slots
describe("chat runs", () => {
  function setupRuns() {
    const s = setup(undefined, async () => ({ text: "10:00", error: null }));
    const log: string[] = [];
    s.runner.onEvent((event) => log.push(event.kind));
    s.runner.onRuns((runs) =>
      log.push(
        `runs:${runs.sends
          .map((run) => `${run.phase}:${run.firstMessageId}/${run.messageId}`)
          .join(",")}`,
      ),
    );
    return { ...s, log };
  }

  test("the slot is published before started, per round before its row, and freed with done", async () => {
    const s = setupRuns();
    s.runner.update(s.chat.id, { toolsOff: [] });
    s.log.length = 0;
    const first = s.runner.send(s.chat.id, "hello");
    const id = first.message.id;
    expect(s.log.slice(0, 3)).toEqual([
      `runs:running:${id}/${id}`,
      "chat",
      "started",
    ]);
    expect(s.runner.runs()).toEqual({
      limits: { mlxserve: 1, openrouter: 0 },
      sends: [
        {
          chatId: s.chat.id,
          provider: "mlxserve",
          firstMessageId: id,
          messageId: id,
          phase: "running",
        },
      ],
    });
    await turn();
    await calls(s.engine.streams[0], [clock("call_1")]);
    await turn();
    // the second round's slot names the new row, and comes before the row
    const round = s.log.indexOf(`runs:running:${id}/${id + 2}`);
    expect(round).toBeGreaterThan(0);
    expect(s.log[round + 1]).toBe("row");
    expect(s.runner.runs().sends[0]).toMatchObject({
      firstMessageId: id,
      messageId: id + 2,
      phase: "running",
    });
    s.engine.streams[1].push({ kind: "content", text: "ten" });
    await finish(s.engine.streams[1]);
    expect(s.log.slice(-2)).toEqual(["done", "runs:"]);
    expect(s.runner.runs()).toEqual({
      limits: { mlxserve: 1, openrouter: 0 },
      sends: [],
    });
    s.db.close();
  });

  test("stop keeps the slot as stopping until the aborted stream drains", async () => {
    const s = setupRuns();
    const sent = s.runner.send(s.chat.id, "hello");
    await turn();
    s.log.length = 0;
    s.runner.stop(s.chat.id);
    const id = sent.message.id;
    expect(s.log.slice(0, 2)).toEqual([`runs:stopping:${id}/${id}`, "html"]);
    expect(s.log).toContain("done");
    expect(s.log.at(-1)).not.toBe("runs:");
    expect(s.runner.runs().sends).toEqual([
      {
        chatId: s.chat.id,
        provider: "mlxserve",
        firstMessageId: id,
        messageId: id,
        phase: "stopping",
      },
    ]);
    await rejects(
      () => s.runner.update(s.chat.id, { model: MODEL }),
      409,
      /cannot change during a send/,
    );
    s.engine.streams[0].end();
    await turn();
    expect(s.log.at(-1)).toBe("runs:");
    expect(s.runner.runs().sends).toEqual([]);
    expect(() => s.runner.update(s.chat.id, { model: MODEL })).not.toThrow();
    s.db.close();
  });

  test("a reply whose row cannot be written ends with the error event", async () => {
    const s = setupRuns();
    s.store.finishReply = () => {
      throw new Error("disk I/O error");
    };
    const sent = s.runner.send(s.chat.id, "hello");
    await turn();
    s.engine.streams[0].push({ kind: "content", text: "partial" });
    await finish(s.engine.streams[0]);
    const id = sent.message.id;
    expect(s.log.slice(-3)).toEqual([
      `runs:stopping:${id}/${id}`,
      "error",
      "runs:",
    ]);
    expect(s.runner.runs().sends).toEqual([]);
    expect(s.logs).toContain(`chat ${s.chat.id} error: disk I/O error`);
    s.db.close();
  });

  test("a store failure on the first row frees the slot", async () => {
    const s = setupRuns();
    const addMessage = s.store.addMessage.bind(s.store);
    let failed = false;
    s.store.addMessage = (chatId, role, fields) => {
      if (role === "assistant" && !failed) {
        failed = true;
        throw new Error("disk full");
      }
      return addMessage(chatId, role, fields);
    };
    expect(() => s.runner.send(s.chat.id, "hello")).toThrow("disk full");
    expect(s.runner.runs().sends).toEqual([]);
    expect(s.log).not.toContain("started");
    const sent = s.runner.send(s.chat.id, "again");
    expect(s.runner.runs().sends[0]).toMatchObject({
      messageId: sent.message.id,
      phase: "running",
    });
    await turn();
    await finish(s.engine.streams[0]);
    expect(s.runner.runs().sends).toEqual([]);
    s.db.close();
  });
});

// Two providers: the engine's one slot and a hosted provider's own cap.
// A send counts against the provider its chat runs on, and nothing else.
describe("providers", () => {
  const REMOTE = "org/remote:free";
  function setupTwo(limit = 2) {
    const now = 1000;
    const db = new Database(":memory:", { strict: true });
    const store = new ChatStore(
      db,
      () => now,
      () => TOOLS.map((tool) => tool.name),
    );
    const engine = new FakeEngine();
    const remote = new FakeEngine();
    const events: ChatWsEvent[] = [];
    const logs: string[] = [];
    const runner = new ChatRunner({
      engine,
      providers: {
        mlxserve: mlxServeProvider(engine, () => [model]),
        openrouter: {
          id: "openrouter",
          limit,
          models: () => [{ id: REMOTE, contextLength: 4000 }],
          chat: (req, signal) => remote.chat(req, signal),
        },
      },
      store,
      log: (line) => logs.push(line),
      now: () => now,
    });
    runner.onEvent((event) => events.push(event));
    const settings = {
      systemPrompt: "",
      thinking: false,
      reasoningEffort: null,
      reasoningHistory: true,
      temperature: null,
      topP: null,
      maxTokens: null,
      toolsOff: TOOLS.map((tool) => tool.name),
      search: "exa" as const,
    };
    const local = runner.create({
      ...settings,
      provider: "mlxserve",
      model: MODEL,
    });
    const a = runner.create({
      ...settings,
      provider: "openrouter",
      model: REMOTE,
    });
    const b = runner.create({
      ...settings,
      provider: "openrouter",
      model: REMOTE,
    });
    const c = runner.create({
      ...settings,
      provider: "openrouter",
      model: REMOTE,
    });
    return { db, store, engine, remote, runner, local, a, b, c, events, logs };
  }

  test("a local send and two hosted sends run together; the third hosted one waits", async () => {
    const s = setupTwo();
    s.runner.send(s.local.id, "one");
    s.runner.send(s.a.id, "two");
    s.runner.send(s.b.id, "three");
    await turn();
    expect(s.engine.requests).toHaveLength(1);
    expect(s.remote.requests).toHaveLength(2);
    expect(s.remote.requests[0].model).toBe(REMOTE);
    expect(s.runner.runs().limits).toEqual({ mlxserve: 1, openrouter: 2 });
    expect(s.runner.runs().sends.map((run) => run.provider)).toEqual([
      "mlxserve",
      "openrouter",
      "openrouter",
    ]);
    await rejects(
      () => s.runner.send(s.c.id, "four"),
      409,
      /OpenRouter: 2 chats running/,
    );
    // the engine's slot is full for a second local chat, not for hosted ones
    const local2 = s.runner.create({
      provider: "mlxserve",
      model: MODEL,
      systemPrompt: "",
      thinking: false,
      reasoningEffort: null,
      reasoningHistory: true,
      temperature: null,
      topP: null,
      maxTokens: null,
      toolsOff: TOOLS.map((tool) => tool.name),
      search: "exa",
    });
    await rejects(
      () => s.runner.send(local2.id, "five"),
      409,
      /already answering in one/,
    );
    // a hosted reply ends: its slot frees, the local one is untouched
    s.remote.streams[0].push({ kind: "content", text: "hi" });
    await finish(s.remote.streams[0]);
    expect(s.runner.runs().sends.map((run) => run.chatId)).toEqual([
      s.local.id,
      s.b.id,
    ]);
    expect(() => s.runner.send(s.c.id, "four")).not.toThrow();
    await turn();
    expect(s.remote.requests).toHaveLength(3);
    for (const chat of [s.local, s.b, s.c]) s.runner.stop(chat.id);
    s.engine.streams[0].end();
    s.remote.streams[1].end();
    s.remote.streams[2].end();
    await turn();
    expect(s.runner.runs().sends).toEqual([]);
    s.db.close();
  });

  test("the provider and model pair is validated together and frozen per send", async () => {
    const s = setupTwo();
    await rejects(
      () => s.runner.update(s.a.id, { model: MODEL }),
      400,
      /not in the OpenRouter list/,
    );
    await rejects(
      () => s.runner.update(s.a.id, { provider: "mlxserve" }),
      400,
      /not loaded anymore/,
    );
    expect(
      s.runner.update(s.a.id, { provider: "mlxserve", model: MODEL }),
    ).toMatchObject({ provider: "mlxserve", model: MODEL });
    s.runner.send(s.a.id, "hello");
    await turn();
    expect(s.engine.requests).toHaveLength(1);
    await rejects(
      () => s.runner.update(s.a.id, { provider: "openrouter", model: REMOTE }),
      409,
      /cannot change during a send/,
    );
    s.runner.stop(s.a.id);
    s.engine.streams[0].end();
    await turn();
    s.db.close();
  });

  test("a hosted chat cannot send when the provider is not configured", async () => {
    const s = setup();
    // a chat saved while the key was there, sent after a start without it
    s.store.create({
      provider: "openrouter",
      model: REMOTE,
      systemPrompt: "",
      thinking: false,
      reasoningEffort: null,
      reasoningHistory: true,
      temperature: null,
      topP: null,
      maxTokens: null,
      search: "exa",
    });
    const saved = s.store.list().find((c) => c.provider === "openrouter")!;
    await rejects(
      () => s.runner.send(saved.id, "hello"),
      400,
      /OpenRouter key missing/,
    );
    await rejects(
      () =>
        s.runner.create({
          provider: "openrouter",
          model: REMOTE,
          systemPrompt: "",
          thinking: false,
          reasoningEffort: null,
          reasoningHistory: true,
          temperature: null,
          topP: null,
          maxTokens: null,
          search: "exa",
        }),
      400,
      /OpenRouter key missing/,
    );
    s.db.close();
  });

  test("a hosted reply's window comes from the provider and its cost is stored", async () => {
    const s = setupTwo();
    const sent = s.runner.send(s.a.id, "hello");
    await turn();
    s.remote.streams[0].push({ kind: "content", text: "hi" });
    s.remote.streams[0].push({ kind: "finish", reason: "stop", details: null });
    s.remote.streams[0].push({
      kind: "usage",
      stats: {
        promptTokens: 3990,
        cachedTokens: 0,
        generated: 5,
        prefillMs: null,
        decodeMs: null,
        tokenizeMs: null,
        cost: 0.0012,
      },
    });
    s.remote.streams[0].end();
    await turn();
    expect(s.store.message(sent.message.id)?.stats?.cost).toBe(0.0012);
    // 3995 of a 4000 window: the summary round follows on the same provider
    await turn();
    expect(s.remote.requests).toHaveLength(2);
    expect(s.remote.requests[1].messages.at(-1)?.content).toMatch(/Summarize/);
    s.runner.stop(s.a.id);
    s.remote.streams[1].end();
    await turn();
    s.db.close();
  });
});
