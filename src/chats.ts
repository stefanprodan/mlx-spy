// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Persistent chat conversations and replies in mlx-spy's SQLite database.
// Streaming rows are durable partial results, so a browser can reconnect to
// the runner without owning the request to the engine.

import type { Database } from "bun:sqlite";
import type { ToolCall } from "./engine/types.ts";
import { renderMarkdown } from "./markdown.ts";
import { isSearchProvider, type SearchProvider } from "./tools/search/types.ts";

export type ChatSettings = {
  model: string;
  systemPrompt: string;
  thinking: boolean;
  reasoningEffort: string | null;
  // send earlier rounds' reasoning back as reasoning_content on every
  // assistant message (what OpenCode does, the default); off keeps the
  // engine's prefix cache stable on a template that drops reasoning
  // before the last user message
  reasoningHistory: boolean;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  toolsOff?: string[];
  search: SearchProvider;
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
  | "pending"
  | "running"
  | "done"
  | "streaming"
  | "stopped"
  | "interrupted"
  | "error";

export type MessageStats = {
  promptTokens: number;
  cachedTokens: number;
  generated: number;
  prefillMs: number | null;
  decodeMs: number | null;
  tokenizeMs: number | null;
};

export type Message = {
  id: number;
  chatId: string;
  role: "user" | "assistant" | "tool";
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
  toolCalls: ToolCall[] | null;
  toolCallId: string | null;
  toolName: string | null;
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
    | "toolCalls"
    | "toolCallId"
    | "toolName"
  >
> & { createdAt?: number };

export type FinishReply = {
  status: "done" | "stopped" | "interrupted" | "error";
  error?: string | null;
  finishReason?: string | null;
  model: string | null;
  finishedAt: number;
  ttftMs: number | null;
  thinkingMs: number | null;
  stats: MessageStats | null;
};

export type WriteTool = {
  status: "pending" | "running" | "done" | "error" | "stopped" | "interrupted";
  content: string;
  error: string | null;
  finishedAt: number | null;
};

type ChatRow = {
  id: string;
  title: string;
  model: string;
  systemPrompt: string;
  thinking: number;
  reasoningEffort: string | null;
  reasoningHistory: number;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  toolsOff: string;
  search: string;
  createdAt: number;
  updatedAt: number;
  streaming: number;
};

type MessageRow = {
  id: number;
  chatId: string;
  role: "user" | "assistant" | "tool";
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
  toolCalls: string | null;
  toolCallId: string | null;
  toolName: string | null;
};

const CHAT_SELECT = `SELECT c.id, c.title, c.model,
  c.system_prompt AS systemPrompt, c.thinking,
  c.reasoning_effort AS reasoningEffort,
  c.reasoning_history AS reasoningHistory, c.temperature,
  c.top_p AS topP, c.max_tokens AS maxTokens, c.tools_off AS toolsOff,
  c.search, c.created_at AS createdAt, c.updated_at AS updatedAt,
  EXISTS(SELECT 1 FROM messages m
    WHERE m.chat_id = c.id AND m.status = 'streaming') AS streaming
  FROM chats c`;

const MESSAGE_SELECT = `SELECT id, chat_id AS chatId, role, content, reasoning,
  status, error, finish_reason AS finishReason, model,
  created_at AS createdAt, finished_at AS finishedAt,
  prompt_tokens AS promptTokens, cached_tokens AS cachedTokens, generated,
  prefill_ms AS prefillMs, decode_ms AS decodeMs, ttft_ms AS ttftMs,
  thinking_ms AS thinkingMs, tokenize_ms AS tokenizeMs,
  tool_calls AS toolCalls, tool_call_id AS toolCallId,
  tool_name AS toolName FROM messages`;

const TOOL_INTERRUPTED = "[Tool execution was interrupted]";

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
  private readonly badToolCalls = new Set<number>();

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
    private readonly knownTools: () => string[] = () => [],
    private readonly log: (line: string) => void = console.error,
  ) {
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      thinking INTEGER NOT NULL DEFAULT 1,
      reasoning_effort TEXT,
      reasoning_history INTEGER NOT NULL DEFAULT 1,
      temperature REAL,
      top_p REAL,
      max_tokens INTEGER,
      tools_off TEXT NOT NULL DEFAULT '[]',
      search TEXT NOT NULL DEFAULT 'exa',
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
      thinking_ms REAL,
      tool_calls TEXT,
      tool_call_id TEXT,
      tool_name TEXT
    )`);
    this.migrateColumns("chats", {
      reasoning_history: "INTEGER NOT NULL DEFAULT 1",
      tools_off: "TEXT NOT NULL DEFAULT '[]'",
      search: "TEXT NOT NULL DEFAULT 'exa'",
    });
    this.migrateColumns("messages", {
      thinking_ms: "REAL",
      tool_calls: "TEXT",
      tool_call_id: "TEXT",
      tool_name: "TEXT",
    });
    this.db.run(
      "CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id, id)",
    );
  }

  private migrateColumns(table: "chats" | "messages", columns: object) {
    const have = new Set(
      (
        this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((column) => column.name),
    );
    for (const [name, type] of Object.entries(columns)) {
      if (!have.has(name)) {
        this.db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    }
  }

  private toolsOff(value: string): string[] {
    try {
      const names = JSON.parse(value);
      if (!Array.isArray(names)) return [];
      const known = new Set(this.knownTools());
      return names.filter(
        (name): name is string => typeof name === "string" && known.has(name),
      );
    } catch {
      return [];
    }
  }

  private summary(row: ChatRow): ChatSummary & ChatSettings {
    return {
      id: row.id,
      title: row.title,
      model: row.model,
      systemPrompt: row.systemPrompt,
      thinking: row.thinking === 1,
      reasoningEffort: row.reasoningEffort,
      reasoningHistory: row.reasoningHistory === 1,
      temperature: row.temperature,
      topP: row.topP,
      maxTokens: row.maxTokens,
      toolsOff: this.toolsOff(row.toolsOff),
      search: isSearchProvider(row.search) ? row.search : "exa",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      streaming: row.streaming === 1,
    };
  }

  private parseToolCalls(row: MessageRow): ToolCall[] | null {
    if (row.toolCalls === null) return null;
    try {
      const calls = JSON.parse(row.toolCalls);
      if (!Array.isArray(calls)) throw new Error("not an array");
      if (
        !calls.every(
          (call) =>
            typeof call?.id === "string" &&
            typeof call?.name === "string" &&
            typeof call?.arguments === "string",
        )
      ) {
        throw new Error("invalid call");
      }
      return calls;
    } catch {
      if (!this.badToolCalls.has(row.id)) {
        this.badToolCalls.add(row.id);
        this.log(`chat message ${row.id} has invalid tool calls`);
      }
      return null;
    }
  }

  private toMessage(row: MessageRow): Message {
    const stats =
      row.promptTokens === null ||
      row.cachedTokens === null ||
      row.generated === null
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
      // a reply still streaming is rendered as the runner renders it: no
      // diagram until it is done (src/markdown.ts)
      html:
        row.role === "assistant"
          ? renderMarkdown(row.content, row.status === "streaming")
          : null,
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
      toolCalls: this.parseToolCalls(row),
      toolCallId: row.toolCallId,
      toolName: row.toolName,
    };
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  create(settings: ChatSettings, title = ""): Chat {
    const id = crypto.randomUUID();
    const now = this.now();
    this.db
      .query(`INSERT INTO chats (id, title, model, system_prompt, thinking,
        reasoning_effort, reasoning_history, temperature, top_p, max_tokens,
        tools_off, search, created_at, updated_at)
        VALUES ($id, $title, $model, $systemPrompt, $thinking,
          $reasoningEffort, $reasoningHistory, $temperature, $topP,
          $maxTokens, $toolsOff, $search, $now, $now)`)
      .run({
        id,
        title,
        model: settings.model,
        systemPrompt: settings.systemPrompt,
        thinking: settings.thinking ? 1 : 0,
        reasoningEffort: settings.reasoningEffort,
        reasoningHistory: settings.reasoningHistory ? 1 : 0,
        temperature: settings.temperature,
        topP: settings.topP,
        maxTokens: settings.maxTokens,
        toolsOff: JSON.stringify(settings.toolsOff ?? []),
        search: settings.search,
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
        reasoningHistory,
        temperature,
        topP,
        maxTokens,
        toolsOff,
        search,
        ...item
      } = this.summary(row);
      void systemPrompt;
      void thinking;
      void reasoningEffort;
      void reasoningHistory;
      void temperature;
      void topP;
      void maxTokens;
      void toolsOff;
      void search;
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
    return {
      ...this.summary(row),
      messages: messages.map((message) => this.toMessage(message)),
    };
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
      ["reasoningHistory", "reasoning_history"],
      ["temperature", "temperature"],
      ["topP", "top_p"],
      ["maxTokens", "max_tokens"],
      ["toolsOff", "tools_off"],
      ["search", "search"],
    ];
    for (const [name, column] of names) {
      if (!(name in patch)) continue;
      columns.push(`${column} = $${name}`);
      if (name === "thinking" || name === "reasoningHistory") {
        values[name] = patch[name] ? 1 : 0;
      } else if (name === "toolsOff") {
        values[name] = JSON.stringify(patch[name] ?? []);
      } else values[name] = patch[name] ?? null;
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
    role: "user" | "assistant" | "tool",
    fields: AddMessageFields = {},
  ): Message {
    const createdAt = fields.createdAt ?? this.now();
    const result = this.db.transaction(() => {
      const id = this.insertMessage(chatId, role, fields, createdAt);
      this.db
        .query("UPDATE chats SET updated_at = $at WHERE id = $chatId")
        .run({ at: createdAt, chatId });
      return id;
    })();
    return this.message(result)!;
  }

  private insertMessage(
    chatId: string,
    role: "user" | "assistant" | "tool",
    fields: AddMessageFields,
    createdAt: number,
  ): number {
    const stats = fields.stats ?? null;
    const inserted = this.db
      .query(`INSERT INTO messages (chat_id, role, content, reasoning, status,
        error, finish_reason, model, created_at, finished_at, prompt_tokens,
        cached_tokens, generated, prefill_ms, decode_ms, ttft_ms, tokenize_ms,
        thinking_ms, tool_calls, tool_call_id, tool_name)
        VALUES ($chatId, $role, $content, $reasoning, $status, $error,
          $finishReason, $model, $createdAt, $finishedAt, $promptTokens,
          $cachedTokens, $generated, $prefillMs, $decodeMs, $ttftMs,
          $tokenizeMs, $thinkingMs, $toolCalls, $toolCallId, $toolName)`)
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
        toolCalls:
          fields.toolCalls === undefined || fields.toolCalls === null
            ? null
            : JSON.stringify(fields.toolCalls),
        toolCallId: fields.toolCallId ?? null,
        toolName: fields.toolName ?? null,
      });
    return Number(inserted.lastInsertRowid);
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

  finishReply(
    id: number,
    fields: FinishReply,
    calls: ToolCall[] | null = null,
  ): Message | null {
    const changed = this.db.transaction(() => {
      const result = this.finishReplyRow(id, fields, calls);
      if (result) this.touchFromMessage(id, fields.finishedAt);
      return result;
    })();
    return changed ? this.message(id) : null;
  }

  setFinishReason(id: number, finishReason: string): Message | null {
    const result = this.db
      .query(`UPDATE messages SET finish_reason = $finishReason
        WHERE id = $id AND role = 'assistant' AND status = 'done'`)
      .run({ id, finishReason });
    return result.changes > 0 ? this.message(id) : null;
  }

  private finishReplyRow(
    id: number,
    fields: FinishReply,
    calls: ToolCall[] | null,
  ): boolean {
    const stats = fields.stats;
    const result = this.db
      .query(`UPDATE messages SET status = $status, error = $error,
        finish_reason = $finishReason, model = $model,
        finished_at = $finishedAt, ttft_ms = $ttftMs,
        thinking_ms = $thinkingMs, tool_calls = $toolCalls,
        prompt_tokens = $promptTokens, cached_tokens = $cachedTokens,
        generated = $generated, prefill_ms = $prefillMs,
        decode_ms = $decodeMs, tokenize_ms = $tokenizeMs
        WHERE id = $id AND role = 'assistant' AND status = 'streaming'`)
      .run({
        id,
        status: fields.status,
        error: fields.error ?? null,
        finishReason: fields.finishReason ?? null,
        model: fields.model,
        finishedAt: fields.finishedAt,
        ttftMs: fields.ttftMs,
        thinkingMs: fields.thinkingMs,
        toolCalls: calls === null ? null : JSON.stringify(calls),
        promptTokens: stats?.promptTokens ?? null,
        cachedTokens: stats?.cachedTokens ?? null,
        generated: stats?.generated ?? null,
        prefillMs: stats?.prefillMs ?? null,
        decodeMs: stats?.decodeMs ?? null,
        tokenizeMs: stats?.tokenizeMs ?? null,
      });
    return result.changes > 0;
  }

  finishToolGroup(
    assistantId: number,
    finish: FinishReply,
    calls: ToolCall[],
  ): Message[] {
    return this.db.transaction(() => {
      if (!this.finishReplyRow(assistantId, finish, calls)) return [];
      const assistant = this.message(assistantId)!;
      const createdAt = this.now();
      const ids = calls.map((call) =>
        this.insertMessage(
          assistant.chatId,
          "tool",
          {
            content: "",
            status: "pending",
            toolCallId: call.id,
            toolName: call.name,
          },
          createdAt,
        ),
      );
      this.touchFromMessage(assistantId, createdAt);
      return ids.map((id) => this.message(id)!);
    })();
  }

  writeTool(id: number, fields: WriteTool): Message | null {
    const changed = this.db.transaction(() => {
      const result = this.db
        .query(`UPDATE messages SET status = $status, content = $content,
          error = $error, finished_at = $finishedAt
          WHERE id = $id AND role = 'tool'
            AND status IN ('pending', 'running')`)
        .run({ id, ...fields });
      if (result.changes > 0 && fields.finishedAt !== null) {
        this.touchFromMessage(id, fields.finishedAt);
      }
      return result.changes > 0;
    })();
    return changed ? this.message(id) : null;
  }

  private touchFromMessage(id: number, at: number) {
    this.db
      .query(`UPDATE chats SET updated_at = $at WHERE id =
        (SELECT chat_id FROM messages WHERE id = $id)`)
      .run({ at, id });
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

  deleteAfterLastUser(chatId: string): number | null {
    return this.db.transaction(() => {
      const user = this.db
        .query(`SELECT id FROM messages WHERE chat_id = $chatId
          AND role = 'user' ORDER BY id DESC LIMIT 1`)
        .get({ chatId }) as { id: number } | null;
      if (!user) return null;
      const first = this.db
        .query(`SELECT id FROM messages WHERE chat_id = $chatId
          AND id > $id ORDER BY id LIMIT 1`)
        .get({ chatId, id: user.id }) as { id: number } | null;
      if (!first) return null;
      this.db
        .query("DELETE FROM messages WHERE chat_id = $chatId AND id > $id")
        .run({ chatId, id: user.id });
      this.db
        .query("UPDATE chats SET updated_at = $at WHERE id = $chatId")
        .run({ at: this.now(), chatId });
      return first.id;
    })();
  }

  message(id: number): Message | null {
    const row = this.db
      .query(`${MESSAGE_SELECT} WHERE id = $id`)
      .get({ id }) as MessageRow | null;
    return row ? this.toMessage(row) : null;
  }

  lastMessage(chatId: string): Message | null {
    const row = this.db
      .query(
        `${MESSAGE_SELECT} WHERE chat_id = $chatId ORDER BY id DESC LIMIT 1`,
      )
      .get({ chatId }) as MessageRow | null;
    return row ? this.toMessage(row) : null;
  }

  repairAtBoot(finishedAt = this.now()): number {
    return this.db.transaction(() => {
      let repaired = this.db
        .query(`UPDATE messages SET status = 'interrupted', finished_at = $at
          WHERE role = 'assistant' AND status = 'streaming'`)
        .run({ at: finishedAt }).changes;
      repaired += this.db
        .query(`UPDATE messages SET status = 'interrupted', content = $content,
          finished_at = $at WHERE role = 'tool'
          AND status IN ('pending', 'running')`)
        .run({ at: finishedAt, content: TOOL_INTERRUPTED }).changes;

      const assistants = this.db
        .query(`${MESSAGE_SELECT} WHERE role = 'assistant'
          AND tool_calls IS NOT NULL ORDER BY chat_id, id`)
        .all() as MessageRow[];
      for (const row of assistants) {
        const calls = this.parseToolCalls(row);
        if (!calls || calls.length === 0) continue;
        // A repaired row may land after later turns, so call identity keeps a
        // second boot from inserting it again.
        const toolRows = this.db
          .query(`SELECT tool_call_id AS toolCallId FROM messages
            WHERE chat_id = $chatId AND role = 'tool'`)
          .all({ chatId: row.chatId }) as {
          toolCallId: string | null;
        }[];
        const have = new Set(toolRows.map((tool) => tool.toolCallId));
        for (const call of calls) {
          if (have.has(call.id)) continue;
          this.insertMessage(
            row.chatId,
            "tool",
            {
              content: TOOL_INTERRUPTED,
              status: "interrupted",
              finishedAt,
              toolCallId: call.id,
              toolName: call.name,
            },
            finishedAt,
          );
          repaired++;
        }
      }
      return repaired;
    })();
  }

  repairInterrupted(finishedAt = this.now()): number {
    return this.repairAtBoot(finishedAt);
  }
}
