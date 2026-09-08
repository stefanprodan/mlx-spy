import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChatSettings, ChatStore, titleFrom } from "../src/chats.ts";
import type { ToolCall } from "../src/engine/types.ts";

const defaults: ChatSettings = {
  model: "org/model",
  systemPrompt: "",
  thinking: true,
  reasoningEffort: null,
  temperature: null,
  topP: null,
  maxTokens: null,
  toolsOff: [],
};

function setup(
  knownTools: () => string[] = () => [],
  log: (line: string) => void = () => {},
) {
  let now = 1000;
  const db = new Database(":memory:", { strict: true });
  const store = new ChatStore(db, () => now, knownTools, log);
  return {
    db,
    store,
    setNow(value: number) {
      now = value;
    },
  };
}

const finish = (finishedAt = 1500) => ({
  status: "done" as const,
  finishReason: "tool_calls",
  model: defaults.model,
  finishedAt,
  ttftMs: 42,
  thinkingMs: null,
  stats: {
    promptTokens: 12,
    cachedTokens: 3,
    generated: 4,
    prefillMs: null,
    decodeMs: null,
    tokenizeMs: null,
  },
});

describe("titleFrom", () => {
  test("uses the first non-empty collapsed line and caps it at 48 chars", () => {
    expect(titleFrom("\n  hello   wide world \nignored")).toBe(
      "hello wide world",
    );
    const title = titleFrom("x".repeat(60));
    expect(title).toBe(`${"x".repeat(47)}…`);
    expect(title.length).toBe(48);
    expect(titleFrom(" \n\t ")).toBe("");
  });
});

describe("ChatStore", () => {
  test("creates, gets, updates and lists newest first", () => {
    const { db, store, setNow } = setup(() => ["clock", "fetch"]);
    const first = store.create(defaults, "first");
    setNow(2000);
    const second = store.create(
      {
        ...defaults,
        model: "org/other",
        systemPrompt: "be brief",
        thinking: false,
        reasoningEffort: "low",
        temperature: 0.4,
        topP: 0.8,
        maxTokens: 50,
        toolsOff: ["clock"],
      },
      "second",
    );
    expect(store.list().map((chat) => chat.id)).toEqual([second.id, first.id]);
    setNow(3000);
    const updated = store.update(first.id, {
      title: "changed",
      model: "org/new",
      systemPrompt: "system",
      thinking: false,
      reasoningEffort: "high",
      temperature: 1.2,
      topP: 0.9,
      maxTokens: 99,
      toolsOff: ["fetch"],
    });
    expect(updated).toMatchObject({
      title: "changed",
      model: "org/new",
      systemPrompt: "system",
      thinking: false,
      reasoningEffort: "high",
      temperature: 1.2,
      topP: 0.9,
      maxTokens: 99,
      toolsOff: ["fetch"],
      updatedAt: 3000,
      messages: [],
    });
    expect(store.list()[0].id).toBe(first.id);
    expect(store.update("missing", { title: "x" })).toBeNull();
    db.close();
  });

  test("appends, writes and finishes a reply with nullable timing stats", () => {
    const { db, store, setNow } = setup();
    const chat = store.create(defaults);
    const user = store.addMessage(chat.id, "user", {
      content: "hello",
      status: "done",
    });
    setNow(1200);
    const reply = store.addMessage(chat.id, "assistant", {
      status: "streaming",
      model: defaults.model,
    });
    expect(user.html).toBeNull();
    expect(store.get(chat.id)?.streaming).toBe(true);
    expect(
      store.writeReply(reply.id, {
        content: "**answer**",
        reasoning: "thinking",
      }),
    ).toBe(true);
    const stats = {
      promptTokens: 12,
      cachedTokens: 3,
      generated: 4,
      prefillMs: null,
      decodeMs: null,
      tokenizeMs: 1.5,
    };
    const done = store.finishReply(reply.id, {
      status: "done",
      finishReason: "stop/repetition_loop",
      model: defaults.model,
      finishedAt: 1500,
      ttftMs: 42,
      thinkingMs: 800,
      stats,
    });
    expect(done).toMatchObject({
      content: "**answer**",
      reasoning: "thinking",
      status: "done",
      finishReason: "stop/repetition_loop",
      finishedAt: 1500,
      ttftMs: 42,
      stats,
      toolCalls: null,
    });
    expect(done?.html).toContain("<strong>answer</strong>");
    expect(store.get(chat.id)?.streaming).toBe(false);
    expect(
      store.finishReply(reply.id, {
        status: "error",
        model: defaults.model,
        finishedAt: 1600,
        ttftMs: 1,
        thinkingMs: null,
        stats: null,
      }),
    ).toBeNull();
    expect(store.writeReply(reply.id, { content: "late", reasoning: "" })).toBe(
      false,
    );
    db.close();
  });

  test("round trips tool calls and logs malformed JSON once", () => {
    const lines: string[] = [];
    const { db, store } = setup(
      () => [],
      (line) => lines.push(line),
    );
    const chat = store.create(defaults);
    const calls: ToolCall[] = [
      { id: "call_1", name: "clock", arguments: '{"timezone":"UTC"}' },
    ];
    const assistant = store.addMessage(chat.id, "assistant", {
      content: "",
      toolCalls: calls,
    });
    expect(store.message(assistant.id)?.toolCalls).toEqual(calls);
    db.query("UPDATE messages SET tool_calls = 'not json' WHERE id = $id").run({
      id: assistant.id,
    });
    expect(store.message(assistant.id)?.toolCalls).toBeNull();
    expect(store.message(assistant.id)?.toolCalls).toBeNull();
    expect(lines).toEqual([
      `chat message ${assistant.id} has invalid tool calls`,
    ]);
    db.close();
  });

  test("adds tool rows with their call identity", () => {
    const { db, store } = setup();
    const chat = store.create(defaults);
    const tool = store.addMessage(chat.id, "tool", {
      status: "pending",
      toolCallId: "call_1",
      toolName: "clock",
    });
    expect(tool).toMatchObject({
      role: "tool",
      status: "pending",
      content: "",
      html: null,
      toolCallId: "call_1",
      toolName: "clock",
    });
    db.close();
  });

  test("finishes an assistant and inserts its pending tool group atomically", () => {
    const { db, store, setNow } = setup();
    const chat = store.create(defaults);
    const assistant = store.addMessage(chat.id, "assistant", {
      status: "streaming",
    });
    const calls: ToolCall[] = [
      { id: "call_1", name: "clock", arguments: "{}" },
      { id: "call_2", name: "fetch", arguments: '{"url":"https://x"}' },
    ];
    setNow(1400);
    const tools = store.finishToolGroup(assistant.id, finish(), calls);
    expect(store.message(assistant.id)).toMatchObject({
      status: "done",
      toolCalls: calls,
      stats: finish().stats,
    });
    expect(tools).toHaveLength(2);
    expect(tools.map((tool) => [tool.status, tool.toolCallId])).toEqual([
      ["pending", "call_1"],
      ["pending", "call_2"],
    ]);
    expect(tools.every((tool) => tool.createdAt === 1400)).toBe(true);
    expect(store.finishToolGroup(assistant.id, finish(), calls)).toEqual([]);
    db.close();
  });

  test("moves tool rows through running and terminal writes", () => {
    const { db, store } = setup();
    const chat = store.create(defaults);
    const tool = store.addMessage(chat.id, "tool", {
      status: "pending",
      toolCallId: "call_1",
      toolName: "clock",
    });
    expect(
      store.writeTool(tool.id, {
        status: "running",
        content: "",
        error: null,
        finishedAt: null,
      }),
    ).toMatchObject({ status: "running", finishedAt: null });
    expect(
      store.writeTool(tool.id, {
        status: "done",
        content: '{"time":"15:00"}',
        error: null,
        finishedAt: 1700,
      }),
    ).toMatchObject({
      status: "done",
      content: '{"time":"15:00"}',
      finishedAt: 1700,
    });
    expect(
      store.writeTool(tool.id, {
        status: "error",
        content: "late",
        error: "late",
        finishedAt: 1800,
      }),
    ).toBeNull();
    db.close();
  });

  test("deleteFrom truncates a branch and remove cascades messages", () => {
    const { db, store } = setup();
    const chat = store.create(defaults);
    const one = store.addMessage(chat.id, "user", { content: "one" });
    const two = store.addMessage(chat.id, "assistant", { content: "two" });
    store.addMessage(chat.id, "user", { content: "three" });
    expect(store.deleteFrom(chat.id, two.id)).toBe(2);
    expect(store.get(chat.id)?.messages.map((message) => message.id)).toEqual([
      one.id,
    ]);
    expect(store.lastMessage(chat.id)?.id).toBe(one.id);
    expect(store.remove(chat.id)).toBe(true);
    expect(store.get(chat.id)).toBeNull();
    const count = db.query("SELECT count(*) AS n FROM messages").get() as {
      n: number;
    };
    expect(count.n).toBe(0);
    expect(store.remove(chat.id)).toBe(false);
    db.close();
  });

  test("deletes every row after the last user for regeneration", () => {
    const { db, store } = setup();
    const chat = store.create(defaults);
    store.addMessage(chat.id, "user", { content: "first" });
    store.addMessage(chat.id, "assistant", { content: "first reply" });
    const lastUser = store.addMessage(chat.id, "user", { content: "again" });
    const firstDeleted = store.addMessage(chat.id, "assistant", {
      content: "calling",
    });
    store.addMessage(chat.id, "tool", {
      content: "result",
      toolCallId: "call_1",
      toolName: "clock",
    });
    store.addMessage(chat.id, "assistant", { content: "final" });
    expect(store.deleteAfterLastUser(chat.id)).toBe(firstDeleted.id);
    expect(store.lastMessage(chat.id)?.id).toBe(lastUser.id);
    expect(store.deleteAfterLastUser(chat.id)).toBeNull();
    db.close();
  });

  test("transaction rolls replacement writes back together", () => {
    const { db, store } = setup();
    const chat = store.create(defaults);
    const original = store.addMessage(chat.id, "user", { content: "old" });
    expect(() =>
      store.transaction(() => {
        store.deleteFrom(chat.id, original.id);
        store.addMessage(chat.id, "user", { content: "new" });
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(store.get(chat.id)?.messages).toEqual([original]);
    db.close();
  });

  test("repairs assistant, tool and incomplete group rows at boot", () => {
    const { db, store } = setup();
    const chat = store.create(defaults);
    const streaming = store.addMessage(chat.id, "assistant", {
      status: "streaming",
    });
    const pending = store.addMessage(chat.id, "tool", {
      status: "pending",
      toolCallId: "loose_1",
      toolName: "clock",
    });
    const running = store.addMessage(chat.id, "tool", {
      status: "running",
      toolCallId: "loose_2",
      toolName: "fetch",
    });
    const calls: ToolCall[] = [
      { id: "call_1", name: "clock", arguments: "{}" },
      { id: "call_2", name: "fetch", arguments: "{}" },
    ];
    store.addMessage(chat.id, "assistant", {
      status: "done",
      toolCalls: calls,
    });
    store.addMessage(chat.id, "tool", {
      status: "done",
      content: "ok",
      toolCallId: "call_1",
      toolName: "clock",
    });

    expect(store.repairAtBoot(9000)).toBe(4);
    expect(store.message(streaming.id)).toMatchObject({
      status: "interrupted",
      finishedAt: 9000,
    });
    for (const row of [pending, running]) {
      expect(store.message(row.id)).toMatchObject({
        status: "interrupted",
        content: "[Tool execution was interrupted]",
        finishedAt: 9000,
      });
    }
    const repaired = store
      .get(chat.id)!
      .messages.filter((message) => message.toolCallId === "call_2");
    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toMatchObject({
      role: "tool",
      status: "interrupted",
      content: "[Tool execution was interrupted]",
      toolName: "fetch",
    });
    expect(store.repairAtBoot()).toBe(0);
    db.close();
  });

  test("keeps repairInterrupted as the boot repair entry point", () => {
    const { db, store } = setup();
    const chat = store.create(defaults);
    const row = store.addMessage(chat.id, "assistant", {
      status: "streaming",
    });
    expect(store.repairInterrupted(8000)).toBe(1);
    expect(store.message(row.id)).toMatchObject({
      status: "interrupted",
      finishedAt: 8000,
    });
    db.close();
  });

  test("stores disabled names and drops unknown tools on read", () => {
    const { db, store } = setup(() => ["clock", "fetch"]);
    const chat = store.create({
      ...defaults,
      toolsOff: ["clock", "removed"],
    });
    expect(chat.toolsOff).toEqual(["clock"]);
    const raw = db
      .query("SELECT tools_off AS toolsOff FROM chats WHERE id = $id")
      .get({ id: chat.id }) as { toolsOff: string };
    expect(JSON.parse(raw.toolsOff)).toEqual(["clock", "removed"]);
    expect(store.create(defaults).toolsOff).toEqual([]);
    db.close();
  });

  test("migrates old chat and message tables idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "mlx-spy-chats-"));
    const path = join(dir, "history.sqlite");
    try {
      const old = new Database(path, { create: true });
      old.run(`CREATE TABLE chats (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        thinking INTEGER NOT NULL DEFAULT 1, reasoning_effort TEXT,
        temperature REAL, top_p REAL, max_tokens INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`);
      old.run(`CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
        reasoning TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        error TEXT, finish_reason TEXT, model TEXT,
        created_at INTEGER NOT NULL, finished_at INTEGER,
        prompt_tokens INTEGER, cached_tokens INTEGER, generated INTEGER,
        prefill_ms REAL, decode_ms REAL, ttft_ms REAL, tokenize_ms REAL,
        thinking_ms REAL
      )`);
      old.close();

      const migrated = new Database(path, { strict: true });
      const first = new ChatStore(migrated, Date.now, () => ["clock"]);
      const chat = first.create(defaults);
      expect(chat.toolsOff).toEqual([]);
      expect(
        first.addMessage(chat.id, "tool", {
          toolCallId: "call_1",
          toolName: "clock",
        }),
      ).toMatchObject({ role: "tool", toolCallId: "call_1" });
      new ChatStore(migrated, Date.now, () => ["clock"]);
      const chatColumns = migrated.query("PRAGMA table_info(chats)").all() as {
        name: string;
      }[];
      const messageColumns = migrated
        .query("PRAGMA table_info(messages)")
        .all() as { name: string }[];
      expect(chatColumns.map((column) => column.name)).toContain("tools_off");
      expect(messageColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["tool_calls", "tool_call_id", "tool_name"]),
      );
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("foreign keys reject orphan messages", () => {
    const { db, store } = setup();
    expect(() =>
      store.addMessage("missing", "user", { content: "x" }),
    ).toThrow();
    db.close();
  });
});
