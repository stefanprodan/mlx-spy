import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type ChatSettings, ChatStore, titleFrom } from "../src/chats.ts";

const defaults: ChatSettings = {
  model: "org/model",
  systemPrompt: "",
  thinking: true,
  reasoningEffort: null,
  temperature: null,
  topP: null,
  maxTokens: null,
};

function setup() {
  let now = 1000;
  const db = new Database(":memory:", { strict: true });
  const store = new ChatStore(db, () => now);
  return {
    db,
    store,
    setNow(value: number) {
      now = value;
    },
  };
}

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
    const { db, store, setNow } = setup();
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
      updatedAt: 3000,
      messages: [],
    });
    expect(store.list()[0].id).toBe(first.id);
    expect(store.update("missing", { title: "x" })).toBeNull();
    db.close();
  });

  test("appends, writes and finishes a reply with rendered HTML and stats", () => {
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
      prefillMs: 10.5,
      decodeMs: 20.5,
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

  test("repairs streaming rows at boot and reports the count", () => {
    const { db, store } = setup();
    const first = store.create(defaults);
    const second = store.create(defaults);
    const a = store.addMessage(first.id, "assistant", { status: "streaming" });
    const b = store.addMessage(second.id, "assistant", { status: "streaming" });
    store.addMessage(first.id, "user", { content: "done" });
    expect(store.repairInterrupted(9000)).toBe(2);
    expect(store.message(a.id)).toMatchObject({
      status: "interrupted",
      finishedAt: 9000,
    });
    expect(store.message(b.id)?.status).toBe("interrupted");
    expect(store.repairInterrupted()).toBe(0);
    db.close();
  });

  test("foreign keys reject orphan messages", () => {
    const { db, store } = setup();
    expect(() =>
      store.addMessage("missing", "user", { content: "x" }),
    ).toThrow();
    db.close();
  });
});
