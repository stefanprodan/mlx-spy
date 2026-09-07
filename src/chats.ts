// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Persistent chat conversations and replies in mlx-spy's SQLite database.
// Streaming rows are durable partial results, so a browser can reconnect to
// the runner without owning the request to the engine.

import type { Database } from "bun:sqlite";
import { renderMarkdown } from "./markdown.ts";

export type ChatSettings = {
  model: string;
  systemPrompt: string;
  thinking: boolean;
  reasoningEffort: string | null;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
};

export type ChatSummary = {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  streaming: boolean;
};

export type Chat = ChatSummary & ChatSettings & { messages: Message[] };

export type MessageStatus =
  | "done"
  | "streaming"
  | "stopped"
  | "interrupted"
  | "error";

export type MessageStats = {
  promptTokens: number;
  cachedTokens: number;
  generated: number;
  prefillMs: number;
  decodeMs: number;
  tokenizeMs: number | null;
};

export type Message = {
  id: number;
  chatId: string;
  role: "user" | "assistant";
  content: string;
  html: string | null;
  reasoning: string;
  status: MessageStatus;
  error: string | null;
  finishReason: string | null;
  model: string | null;
  createdAt: number;
  finishedAt: number | null;
  ttftMs: number | null;
  // first reasoning token to first content token, measured by the runner
  thinkingMs: number | null;
  stats: MessageStats | null;
};

export type ChatPatch = Partial<ChatSettings & { title: string }>;

export type AddMessageFields = Partial<
  Pick<
    Message,
    | "content"
    | "reasoning"
    | "status"
    | "error"
    | "finishReason"
    | "model"
    | "finishedAt"
    | "ttftMs"
    | "thinkingMs"
    | "stats"
  >
> & { createdAt?: number };

export type FinishReply = {
  status: Exclude<MessageStatus, "streaming">;
  error?: string | null;
  finishReason?: string | null;
  model: string | null;
  finishedAt: number;
  ttftMs: number | null;
  thinkingMs: number | null;
  stats: MessageStats | null;
};

type ChatRow = {
  id: string;
  title: string;
  model: string;
  systemPrompt: string;
  thinking: number;
  reasoningEffort: string | null;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  createdAt: number;
  updatedAt: number;
  streaming: number;
};

type MessageRow = {
  id: number;
  chatId: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string;
  status: MessageStatus;
  error: string | null;
  finishReason: string | null;
  model: string | null;
  createdAt: number;
  finishedAt: number | null;
  promptTokens: number | null;
  cachedTokens: number | null;
  generated: number | null;
  prefillMs: number | null;
  decodeMs: number | null;
  ttftMs: number | null;
  thinkingMs: number | null;
  tokenizeMs: number | null;
};

const CHAT_SELECT = `SELECT c.id, c.title, c.model,
  c.system_prompt AS systemPrompt, c.thinking,
  c.reasoning_effort AS reasoningEffort, c.temperature,
  c.top_p AS topP, c.max_tokens AS maxTokens,
  c.created_at AS createdAt, c.updated_at AS updatedAt,
  EXISTS(SELECT 1 FROM messages m
    WHERE m.chat_id = c.id AND m.status = 'streaming') AS streaming
  FROM chats c`;

const MESSAGE_SELECT = `SELECT id, chat_id AS chatId, role, content, reasoning,
  status, error, finish_reason AS finishReason, model,
  created_at AS createdAt, finished_at AS finishedAt,
  prompt_tokens AS promptTokens, cached_tokens AS cachedTokens, generated,
  prefill_ms AS prefillMs, decode_ms AS decodeMs, ttft_ms AS ttftMs,
  thinking_ms AS thinkingMs, tokenize_ms AS tokenizeMs FROM messages`;

function summary(row: ChatRow): ChatSummary & ChatSettings {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    systemPrompt: row.systemPrompt,
    thinking: row.thinking === 1,
    reasoningEffort: row.reasoningEffort,
    temperature: row.temperature,
    topP: row.topP,
    maxTokens: row.maxTokens,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    streaming: row.streaming === 1,
  };
}

function message(row: MessageRow): Message {
  const stats =
    row.promptTokens === null ||
    row.cachedTokens === null ||
    row.generated === null ||
    row.prefillMs === null ||
    row.decodeMs === null
      ? null
      : {
          promptTokens: row.promptTokens,
          cachedTokens: row.cachedTokens,
          generated: row.generated,
          prefillMs: row.prefillMs,
          decodeMs: row.decodeMs,
          tokenizeMs: row.tokenizeMs,
        };
  return {
    id: row.id,
    chatId: row.chatId,
    role: row.role,
    content: row.content,
    html: row.role === "assistant" ? renderMarkdown(row.content) : null,
    reasoning: row.reasoning,
    status: row.status,
    error: row.error,
    finishReason: row.finishReason,
    model: row.model,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    ttftMs: row.ttftMs,
    thinkingMs: row.thinkingMs,
    stats,
  };
}

export function titleFrom(text: string): string {
  const line = text
    .split(/\r?\n/)
    .find((part) => part.trim() !== "")
    ?.trim()
    .replace(/\s+/g, " ");
  if (!line) return "";
  return line.length <= 48 ? line : `${line.slice(0, 47)}…`;
}

export class ChatStore {
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    now: () => number = Date.now,
  ) {
    this.now = now;
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      thinking INTEGER NOT NULL DEFAULT 1,
      reasoning_effort TEXT,
      temperature REAL,
      top_p REAL,
      max_tokens INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      reasoning TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      error TEXT,
      finish_reason TEXT,
      model TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      prompt_tokens INTEGER, cached_tokens INTEGER, generated INTEGER,
      prefill_ms REAL, decode_ms REAL, ttft_ms REAL, tokenize_ms REAL,
      thinking_ms REAL
    )`);
    // columns added after the first release are appended to an existing file
    const have = new Set(
      (
        this.db.query("PRAGMA table_info(messages)").all() as { name: string }[]
      ).map((c) => c.name),
    );
    if (!have.has("thinking_ms")) {
      this.db.run("ALTER TABLE messages ADD COLUMN thinking_ms REAL");
    }
    this.db.run(
      "CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id, id)",
    );
  }

  create(settings: ChatSettings, title = ""): Chat {
    const id = crypto.randomUUID();
    const now = this.now();
    this.db
      .query(`INSERT INTO chats (id, title, model, system_prompt, thinking,
        reasoning_effort, temperature, top_p, max_tokens, created_at, updated_at)
        VALUES ($id, $title, $model, $systemPrompt, $thinking,
          $reasoningEffort, $temperature, $topP, $maxTokens, $now, $now)`)
      .run({
        id,
        title,
        model: settings.model,
        systemPrompt: settings.systemPrompt,
        thinking: settings.thinking ? 1 : 0,
        reasoningEffort: settings.reasoningEffort,
        temperature: settings.temperature,
        topP: settings.topP,
        maxTokens: settings.maxTokens,
        now,
      });
    return this.get(id)!;
  }

  list(): ChatSummary[] {
    const rows = this.db
      .query(
        `${CHAT_SELECT} ORDER BY c.updated_at DESC, c.created_at DESC, c.id`,
      )
      .all() as ChatRow[];
    return rows.map((row) => {
      const {
        systemPrompt,
        thinking,
        reasoningEffort,
        temperature,
        topP,
        maxTokens,
        ...item
      } = summary(row);
      void systemPrompt;
      void thinking;
      void reasoningEffort;
      void temperature;
      void topP;
      void maxTokens;
      return item;
    });
  }

  get(id: string): Chat | null {
    const row = this.db
      .query(`${CHAT_SELECT} WHERE c.id = $id`)
      .get({ id }) as ChatRow | null;
    if (!row) return null;
    const messages = this.db
      .query(`${MESSAGE_SELECT} WHERE chat_id = $id ORDER BY id`)
      .all({ id }) as MessageRow[];
    return { ...summary(row), messages: messages.map(message) };
  }

  update(id: string, patch: ChatPatch): Chat | null {
    const columns: string[] = [];
    const values: Record<string, string | number | null> = {
      id,
      now: this.now(),
    };
    const names: [keyof ChatPatch, string][] = [
      ["title", "title"],
      ["model", "model"],
      ["systemPrompt", "system_prompt"],
      ["thinking", "thinking"],
      ["reasoningEffort", "reasoning_effort"],
      ["temperature", "temperature"],
      ["topP", "top_p"],
      ["maxTokens", "max_tokens"],
    ];
    for (const [name, column] of names) {
      if (!(name in patch)) continue;
      columns.push(`${column} = $${name}`);
      values[name] =
        name === "thinking" ? (patch[name] ? 1 : 0) : (patch[name] ?? null);
    }
    if (columns.length === 0) return this.get(id);
    columns.push("updated_at = $now");
    this.db
      .query(`UPDATE chats SET ${columns.join(", ")} WHERE id = $id`)
      .run(values);
    return this.get(id);
  }

  remove(id: string): boolean {
    return (
      this.db.query("DELETE FROM chats WHERE id = $id").run({ id }).changes > 0
    );
  }

  addMessage(
    chatId: string,
    role: "user" | "assistant",
    fields: AddMessageFields = {},
  ): Message {
    const createdAt = fields.createdAt ?? this.now();
    const stats = fields.stats ?? null;
    const result = this.db.transaction(() => {
      const inserted = this.db
        .query(`INSERT INTO messages (chat_id, role, content, reasoning, status,
          error, finish_reason, model, created_at, finished_at, prompt_tokens,
          cached_tokens, generated, prefill_ms, decode_ms, ttft_ms, tokenize_ms,
          thinking_ms)
          VALUES ($chatId, $role, $content, $reasoning, $status, $error,
            $finishReason, $model, $createdAt, $finishedAt, $promptTokens,
            $cachedTokens, $generated, $prefillMs, $decodeMs, $ttftMs,
            $tokenizeMs, $thinkingMs)`)
        .run({
          chatId,
          role,
          content: fields.content ?? "",
          reasoning: fields.reasoning ?? "",
          status: fields.status ?? "done",
          error: fields.error ?? null,
          finishReason: fields.finishReason ?? null,
          model: fields.model ?? null,
          createdAt,
          finishedAt: fields.finishedAt ?? null,
          promptTokens: stats?.promptTokens ?? null,
          cachedTokens: stats?.cachedTokens ?? null,
          generated: stats?.generated ?? null,
          prefillMs: stats?.prefillMs ?? null,
          decodeMs: stats?.decodeMs ?? null,
          ttftMs: fields.ttftMs ?? null,
          tokenizeMs: stats?.tokenizeMs ?? null,
          thinkingMs: fields.thinkingMs ?? null,
        });
      this.db
        .query("UPDATE chats SET updated_at = $at WHERE id = $chatId")
        .run({ at: createdAt, chatId });
      return Number(inserted.lastInsertRowid);
    })();
    return this.message(result)!;
  }

  writeReply(
    id: number,
    fields: { content: string; reasoning: string },
  ): boolean {
    const result = this.db
      .query(`UPDATE messages SET content = $content, reasoning = $reasoning
        WHERE id = $id AND status = 'streaming'`)
      .run({ id, ...fields });
    return result.changes > 0;
  }

  finishReply(id: number, fields: FinishReply): Message | null {
    const stats = fields.stats;
    const changed = this.db.transaction(() => {
      const result = this.db
        .query(`UPDATE messages SET status = $status, error = $error,
          finish_reason = $finishReason, model = $model,
          finished_at = $finishedAt, ttft_ms = $ttftMs,
          thinking_ms = $thinkingMs,
          prompt_tokens = $promptTokens, cached_tokens = $cachedTokens,
          generated = $generated, prefill_ms = $prefillMs,
          decode_ms = $decodeMs, tokenize_ms = $tokenizeMs
          WHERE id = $id AND status = 'streaming'`)
        .run({
          id,
          status: fields.status,
          error: fields.error ?? null,
          finishReason: fields.finishReason ?? null,
          model: fields.model,
          finishedAt: fields.finishedAt,
          ttftMs: fields.ttftMs,
          thinkingMs: fields.thinkingMs,
          promptTokens: stats?.promptTokens ?? null,
          cachedTokens: stats?.cachedTokens ?? null,
          generated: stats?.generated ?? null,
          prefillMs: stats?.prefillMs ?? null,
          decodeMs: stats?.decodeMs ?? null,
          tokenizeMs: stats?.tokenizeMs ?? null,
        });
      if (result.changes > 0) {
        this.db
          .query(`UPDATE chats SET updated_at = $at WHERE id =
            (SELECT chat_id FROM messages WHERE id = $id)`)
          .run({ at: fields.finishedAt, id });
      }
      return result.changes > 0;
    })();
    return changed ? this.message(id) : null;
  }

  deleteFrom(chatId: string, messageId: number): number {
    return this.db.transaction(() => {
      const result = this.db
        .query("DELETE FROM messages WHERE chat_id = $chatId AND id >= $id")
        .run({ chatId, id: messageId });
      if (result.changes > 0) {
        this.db
          .query("UPDATE chats SET updated_at = $at WHERE id = $chatId")
          .run({ at: this.now(), chatId });
      }
      return result.changes;
    })();
  }

  message(id: number): Message | null {
    const row = this.db
      .query(`${MESSAGE_SELECT} WHERE id = $id`)
      .get({ id }) as MessageRow | null;
    return row ? message(row) : null;
  }

  lastMessage(chatId: string): Message | null {
    const row = this.db
      .query(
        `${MESSAGE_SELECT} WHERE chat_id = $chatId ORDER BY id DESC LIMIT 1`,
      )
      .get({ chatId }) as MessageRow | null;
    return row ? message(row) : null;
  }

  repairInterrupted(finishedAt = this.now()): number {
    const result = this.db
      .query(`UPDATE messages SET status = 'interrupted', finished_at = $at
        WHERE status = 'streaming'`)
      .run({ at: finishedAt });
    return result.changes;
  }
}
