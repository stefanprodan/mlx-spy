import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { ChatError, ChatRunner, type ChatWsEvent } from "../src/chat.ts";
import { ChatStore } from "../src/chats.ts";
import type {
  CacheLimits,
  Capability,
  ChatEvent,
  ChatRequest,
  Engine,
  EngineMetrics,
  ModelInfo,
} from "../src/engine/types.ts";

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

function setup(list: ModelInfo[] = [model]) {
  let now = 1000;
  const models = [...list];
  const db = new Database(":memory:", { strict: true });
  const store = new ChatStore(db, () => now);
  const engine = new FakeEngine();
  const events: ChatWsEvent[] = [];
  const logs: string[] = [];
  const runner = new ChatRunner({
    engine,
    store,
    models: () => models,
    log: (line) => logs.push(line),
    now: () => now,
  });
  runner.onEvent((event) => events.push(event));
  const chat = runner.create({
    model: MODEL,
    systemPrompt: "be concise",
    thinking: true,
    reasoningEffort: "low",
    temperature: 0.5,
    topP: 0.9,
    maxTokens: 100,
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
    expect(s.events[0]).toMatchObject({
      kind: "chat",
      chat: { title: "hello" },
    });
    expect(s.events[1]).toMatchObject({ kind: "started", user: started.user });
    expect(s.runner.running()).toEqual({
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
      messages: [
        { role: "system", content: "be concise" },
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
    expect(s.runner.running()).toBeNull();
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
    expect(s.runner.running()).toBeNull();
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
    s.runner.send(s.chat.id, "first");
    await turn();
    await finish(s.engine.streams[0]);
    expect(s.logs.at(-1)).toContain(
      `chat ${s.chat.id} finish failed: disk full`,
    );
    expect(() => s.runner.send(s.chat.id, "second")).not.toThrow();
    await turn();
    s.runner.stop(s.chat.id);
    s.engine.streams[1].end();
    await turn();
    s.db.close();
  });

  test("stop preserves completion and shutdown stores available usage", async () => {
    const stopped = setup();
    const first = stopped.runner.send(stopped.chat.id, "first");
    await turn();
    const firstStream = stopped.engine.streams[0];
    firstStream.push({ kind: "finish", reason: "stop", details: null });
    await turn();
    stopped.runner.stop(stopped.chat.id);
    expect(stopped.engine.signals[0].aborted).toBe(false);
    firstStream.push({
      kind: "usage",
      stats: {
        promptTokens: 8,
        cachedTokens: 2,
        generated: 3,
        prefillMs: 10,
        decodeMs: 20,
        tokenizeMs: null,
      },
    });
    firstStream.end();
    await turn();
    expect(stopped.store.message(first.message.id)).toMatchObject({
      status: "done",
      stats: { promptTokens: 8, generated: 3 },
    });
    stopped.db.close();

    const shutdown = setup();
    const second = shutdown.runner.send(shutdown.chat.id, "second");
    await turn();
    const secondStream = shutdown.engine.streams[0];
    secondStream.push({ kind: "finish", reason: "stop", details: null });
    secondStream.push({
      kind: "usage",
      stats: {
        promptTokens: 9,
        cachedTokens: 1,
        generated: 4,
        prefillMs: 11,
        decodeMs: 22,
        tokenizeMs: 1,
      },
    });
    await turn();
    shutdown.runner.shutdown();
    expect(shutdown.store.message(second.message.id)).toMatchObject({
      status: "done",
      stats: { promptTokens: 9, generated: 4 },
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
      model: MODEL,
      systemPrompt: "",
      thinking: false,
      reasoningEffort: null,
      temperature: null,
      topP: null,
      maxTokens: null,
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
});
