// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The server-side chat runner owns every engine round and tool call after a
// browser leaves. One send remains the unit of locking, stopping and events.

import {
  type Chat,
  type ChatPatch,
  type ChatSettings,
  type ChatStore,
  type ChatSummary,
  type Message,
  type MessageStats,
  titleFrom,
} from "./chats.ts";
import type {
  ChatEvent,
  ChatMessageIn,
  ChatRequest,
  ChatTool,
  Engine,
  ModelInfo,
  ToolCall,
} from "./engine/types.ts";
import { renderMarkdown } from "./markdown.ts";
import {
  formatCurrentTime,
  runTool,
  type SendBudget,
  TOOLS,
  type ToolContext,
  toolSchemas,
} from "./tools.ts";

const MAX_MESSAGE_BYTES = 256 * 1024;
const WRITE_EVERY_MS = 250;
const WRITE_EVERY_BYTES = 2048;
const HTML_EVERY_MS = 1000;
const MAX_ROUNDS = 8;
const MAX_CALLS_PER_ROUND = 8;
const MAX_CALLS_PER_SEND = 24;
const MAX_TOOL_MS = 60_000;
const MAX_RESULT_BYTES = 200 * 1024;
const TOOL_INTERRUPTED = "[Tool execution was interrupted]";
const EXHAUSTED = "Tool calls are exhausted for this turn; answer with text.";

type TerminalStatus = "done" | "stopped" | "interrupted" | "error";

export type ChatWsEvent =
  // deletedFrom: regenerate and edit removed that row and every later one
  | {
      kind: "started";
      chat: ChatSummary;
      user: Message;
      message: Message;
      deletedFrom?: number;
    }
  | {
      kind: "row";
      chatId: string;
      message: Message;
      chat: ChatSummary;
    }
  | {
      kind: "delta";
      chatId: string;
      messageId: number;
      content?: string;
      contentAt: number;
      reasoning?: string;
      reasoningAt: number;
    }
  | {
      kind: "html";
      chatId: string;
      messageId: number;
      html: string;
      htmlAt: number;
    }
  | { kind: "done"; chat: ChatSummary; message: Message }
  // the settings ride along so an open tab follows a change made elsewhere
  | { kind: "chat"; chat: ChatSummary & ChatSettings }
  | { kind: "deleted"; chatId: string };

export class ChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type FrozenPolicy = {
  model: string;
  systemPrompt: string;
  thinking: boolean;
  reasoningEffort: string | null;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  tools: ChatTool[];
};

type RoundState = {
  messageId: number;
  startedAt: number;
  content: string;
  reasoning: string;
  ttftMs: number | null;
  reasoningStartedAt: number | null;
  thinkingMs: number | null;
  lastWriteAt: number;
  lastWriteSize: number;
  lastHtmlAt: number;
  htmlAt: number;
  finishReason: string | null;
  stats: MessageStats | null;
  calls: ToolCall[];
  toolRows: Message[];
};

type ActiveSend = {
  chatId: string;
  userId: number;
  policy: FrozenPolicy;
  round: number;
  budget: SendBudget;
  controller: AbortController;
  terminal: TerminalStatus | null;
  rows: number[];
  current: RoundState | null;
  tools: Promise<void> | null;
  signatures: string[];
};

type ToolExecutor = (
  call: ToolCall,
  ctx: ToolContext,
) => Promise<{ text: string; error: string | null }>;

export type ChatRunnerDeps = {
  engine: Engine;
  store: ChatStore;
  models: () => ModelInfo[];
  log: (line: string) => void;
  now?: () => number;
  version?: string;
  runTool?: ToolExecutor;
};

function chatSummary(chat: Chat): ChatSummary {
  return {
    id: chat.id,
    title: chat.title,
    model: chat.model,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    streaming: chat.streaming,
  };
}

function chatSettings(chat: Chat): ChatSummary & ChatSettings {
  const { messages, ...rest } = chat;
  return rest;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function finishReason(event: Extract<ChatEvent, { kind: "finish" }>): string {
  return event.details && event.details !== event.reason
    ? `${event.reason}/${event.details}`
    : event.reason;
}

function callSignature(calls: ToolCall[]): string {
  return JSON.stringify(
    calls.map((call) => ({ name: call.name, arguments: call.arguments })),
  );
}

export class ChatRunner {
  private active: ActiveSend | null = null;
  private draining: ActiveSend | null = null;
  private readonly listeners = new Set<(event: ChatWsEvent) => void>();
  private readonly now: () => number;
  private readonly executeTool: ToolExecutor;

  constructor(private readonly deps: ChatRunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.executeTool = deps.runTool ?? runTool;
  }

  onEvent(fn: (event: ChatWsEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  running(): { chatId: string; messageId: number } | null {
    const send = this.active;
    const round = send?.current;
    return send && round && send.terminal === null
      ? { chatId: send.chatId, messageId: round.messageId }
      : null;
  }

  list(): ChatSummary[] {
    return this.deps.store.list();
  }

  get(id: string): Chat | null {
    return this.deps.store.get(id);
  }

  create(settings: ChatSettings, title = ""): Chat {
    this.validateModel(settings.model);
    const chat = this.deps.store.create(settings, title);
    this.publish({ kind: "chat", chat: chatSettings(chat) });
    return chat;
  }

  update(id: string, patch: ChatPatch): (ChatSummary & ChatSettings) | null {
    if (
      this.active?.chatId === id &&
      (patch.model !== undefined || patch.toolsOff !== undefined)
    ) {
      throw new ChatError(409, "Model and tools cannot change during a send");
    }
    if (patch.model !== undefined) this.validateModel(patch.model);
    const chat = this.deps.store.update(id, patch);
    if (!chat) return null;
    const summary = chatSettings(chat);
    this.publish({ kind: "chat", chat: summary });
    return summary;
  }

  send(
    chatId: string,
    text: string,
    deletedFrom?: number,
  ): { user: Message; message: Message } {
    this.ensureIdle();
    this.validateText(text);
    let chat = this.requireChat(chatId);
    this.validateModel(chat.model);
    this.truncateMalformedHistory(chat);
    const titleChanged = chat.title === "" && chat.messages.length === 0;
    const user = this.deps.store.transaction(() => {
      if (titleChanged) {
        this.deps.store.update(chatId, { title: titleFrom(text) });
      }
      return this.deps.store.addMessage(chatId, "user", {
        content: text,
        status: "done",
        createdAt: this.now(),
      });
    });
    chat = this.requireChat(chatId);
    return this.startSend(chat, user, titleChanged, deletedFrom);
  }

  regenerate(chatId: string): { user: Message; message: Message } {
    this.ensureIdle();
    const chat = this.requireChat(chatId);
    const user = [...chat.messages]
      .reverse()
      .find((row) => row.role === "user");
    if (!user || chat.messages.at(-1)?.id === user.id) {
      throw new ChatError(400, "The last message is not an assistant reply");
    }
    this.validateModel(chat.model);
    const deletedFrom = this.deps.store.deleteAfterLastUser(chatId);
    if (deletedFrom === null) {
      throw new ChatError(400, "The last message is not an assistant reply");
    }
    return this.startSend(this.requireChat(chatId), user, false, deletedFrom);
  }

  edit(
    chatId: string,
    messageId: number,
    content: string,
  ): { user: Message; message: Message } {
    this.ensureIdle();
    this.validateText(content);
    const chat = this.requireChat(chatId);
    const row = chat.messages.find((message) => message.id === messageId);
    if (row?.role !== "user") {
      throw new ChatError(400, "The message to edit must be a user message");
    }
    this.validateModel(chat.model);
    const user = this.deps.store.transaction(() => {
      this.deps.store.deleteFrom(chatId, messageId);
      return this.deps.store.addMessage(chatId, "user", {
        content,
        status: "done",
        createdAt: this.now(),
      });
    });
    return this.startSend(this.requireChat(chatId), user, false, messageId);
  }

  stop(chatId: string): void {
    const send = this.active;
    if (!send || send.chatId !== chatId || send.terminal !== null) return;
    this.terminate(send, "stopped");
  }

  remove(chatId: string): boolean {
    if (this.active?.chatId === chatId) this.stop(chatId);
    const removed = this.deps.store.remove(chatId);
    if (removed) this.publish({ kind: "deleted", chatId });
    return removed;
  }

  shutdown(): void {
    const send = this.active;
    if (!send || send.terminal !== null) return;
    this.terminate(send, "interrupted");
  }

  private startSend(
    chat: Chat,
    user: Message,
    titleChanged: boolean,
    deletedFrom?: number,
  ): { user: Message; message: Message } {
    const toolsOff = new Set(chat.toolsOff ?? []);
    const enabled = TOOLS.map((tool) => tool.name).filter(
      (name) => !toolsOff.has(name),
    );
    const tools = toolSchemas(enabled);
    const policy: FrozenPolicy = {
      model: chat.model,
      systemPrompt: this.systemPrompt(chat.systemPrompt, tools.length > 0),
      thinking: chat.thinking,
      reasoningEffort: chat.reasoningEffort,
      temperature: chat.temperature,
      topP: chat.topP,
      maxTokens: chat.maxTokens,
      tools,
    };
    const send: ActiveSend = {
      chatId: chat.id,
      userId: user.id,
      policy,
      round: 1,
      budget: { toolCalls: 0, fetches: 0, toolMs: 0, resultBytes: 0 },
      controller: new AbortController(),
      terminal: null,
      rows: [],
      current: null,
      tools: null,
      signatures: [],
    };
    this.active = send;
    // the started event carries round one's row; a row event before it
    // would land in the page ahead of the user message
    const message = this.beginRound(send, false);
    const current = this.requireChat(chat.id);
    if (titleChanged) {
      this.publish({ kind: "chat", chat: chatSettings(current) });
    }
    this.publish({
      kind: "started",
      chat: chatSummary(current),
      user,
      message,
      deletedFrom,
    });
    this.deps.log(`chat ${chat.id} sent ${chat.model}`);
    void this.run(send, user.id);
    return { user, message };
  }

  private beginRound(send: ActiveSend, announce = true): Message {
    const startedAt = this.now();
    const message = this.deps.store.addMessage(send.chatId, "assistant", {
      status: "streaming",
      model: send.policy.model,
      createdAt: startedAt,
    });
    send.rows.push(message.id);
    send.current = {
      messageId: message.id,
      startedAt,
      content: "",
      reasoning: "",
      ttftMs: null,
      reasoningStartedAt: null,
      thinkingMs: null,
      lastWriteAt: startedAt,
      lastWriteSize: 0,
      lastHtmlAt: startedAt - HTML_EVERY_MS,
      htmlAt: 0,
      finishReason: null,
      stats: null,
      calls: [],
      toolRows: [],
    };
    if (announce) this.publishRow(send.chatId, message);
    return message;
  }

  private async run(send: ActiveSend, firstInputId: number): Promise<void> {
    let lastInputId = firstInputId;
    try {
      while (send.terminal === null) {
        const round = send.current!;
        this.deps.log(
          `chat ${send.chatId} round ${send.round} of ${MAX_ROUNDS}`,
        );
        await this.consumeRound(send, round, this.request(send, lastInputId));
        if (send.terminal !== null) return;
        const calls = round.calls;
        const reason = round.finishReason?.split("/", 1)[0] ?? null;
        if (calls.length === 0) {
          if (reason === "error") {
            this.fail(send, "engine generation failed");
            return;
          }
          const message = this.finishRound(send, round, "done", null);
          if (message) this.complete(send, message);
          return;
        }
        if (reason === "length" || reason === "error") {
          const message = this.finishRound(send, round, "done", null, calls);
          if (message) this.complete(send, message);
          return;
        }
        if (reason !== "stop" && reason !== "tool_calls") {
          const message = this.finishRound(send, round, "done", null, calls);
          if (message) this.complete(send, message);
          return;
        }

        const signature = callSignature(calls);
        send.signatures.push(signature);
        const repeats =
          send.signatures.length >= 3 &&
          send.signatures.slice(-3).every((item) => item === signature);
        const nextCalls = send.budget.toolCalls + calls.length;
        const overLimit =
          calls.length > MAX_CALLS_PER_ROUND ||
          nextCalls > MAX_CALLS_PER_SEND ||
          send.round >= MAX_ROUNDS;
        const terminalReason = repeats
          ? "tool_loop"
          : overLimit
            ? "tool_limit"
            : null;
        send.budget.toolCalls = nextCalls;
        this.deps.store.writeReply(round.messageId, {
          content: round.content,
          reasoning: round.reasoning,
        });
        const toolRows = this.deps.store.finishToolGroup(
          round.messageId,
          // a null override would hide the engine's own tool_calls reason
          this.finishFields(round, "done", null, terminalReason ?? undefined),
          calls,
        );
        round.toolRows = toolRows;
        const assistant = this.deps.store.message(round.messageId);
        if (!assistant) throw new Error("assistant row disappeared");
        this.publishRow(send.chatId, assistant);
        for (const row of toolRows) {
          send.rows.push(row.id);
          this.publishRow(send.chatId, row);
        }
        if (terminalReason !== null) {
          this.interruptTools(send, "stopped");
          if (terminalReason === "tool_loop") {
            this.deps.log(`chat ${send.chatId} tool loop`);
          }
          this.complete(send, this.deps.store.message(round.messageId)!);
          return;
        }

        const tools = Promise.all(
          calls.map((call, index) =>
            this.executeCall(send, call, toolRows[index]),
          ),
        ).then(() => {});
        send.tools = tools;
        await tools;
        send.tools = null;
        if (send.terminal !== null) return;
        if (
          send.budget.toolMs >= MAX_TOOL_MS ||
          send.budget.resultBytes >= MAX_RESULT_BYTES
        ) {
          const message = this.deps.store.setFinishReason(
            round.messageId,
            "tool_limit",
          );
          if (message) this.publishRow(send.chatId, message);
          this.complete(send, message ?? assistant);
          return;
        }
        lastInputId = toolRows.at(-1)!.id;
        send.round++;
        this.beginRound(send);
      }
    } catch (err) {
      if (send.terminal === null) this.fail(send, describe(err));
    } finally {
      if (this.active === send) this.active = null;
      if (this.draining === send) this.draining = null;
    }
  }

  private async consumeRound(
    send: ActiveSend,
    round: RoundState,
    request: ChatRequest,
  ): Promise<void> {
    const chat = this.deps.engine.chat;
    if (!chat) throw new Error(`${this.deps.engine.id} does not support chat`);
    for await (const event of chat.call(
      this.deps.engine,
      request,
      send.controller.signal,
    )) {
      if (send.terminal !== null) return;
      if (event.kind === "reasoning" || event.kind === "content") {
        this.delta(send, round, event);
      } else if (event.kind === "toolCallDelta") {
        this.touchTtft(round);
      } else if (event.kind === "toolCalls") {
        round.calls = event.calls;
      } else if (event.kind === "finish") {
        round.finishReason = finishReason(event);
      } else if (event.kind === "usage") {
        round.stats = event.stats;
      } else if (event.kind === "error") {
        throw new Error(event.message);
      }
    }
    if (send.terminal === null && round.finishReason === null) {
      throw new Error("stream ended early");
    }
  }

  private request(send: ActiveSend, throughId: number): ChatRequest {
    const chat = this.requireChat(send.chatId);
    const messages: ChatMessageIn[] = [];
    let systemPrompt = send.policy.systemPrompt;
    const lastRound = send.round === MAX_ROUNDS;
    if (lastRound) {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${EXHAUSTED}`
        : EXHAUSTED;
    }
    if (systemPrompt !== "") {
      messages.push({ role: "system", content: systemPrompt });
    }
    for (const message of chat.messages) {
      if (message.id > throughId) break;
      if (
        message.content === "" &&
        message.reasoning === "" &&
        message.toolCalls === null
      ) {
        continue;
      }
      if (message.role === "assistant") {
        messages.push({
          role: "assistant",
          content:
            message.toolCalls && message.content === ""
              ? null
              : message.content,
          ...(message.reasoning ? { reasoning: message.reasoning } : {}),
          ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
        });
      } else if (message.role === "tool") {
        messages.push({
          role: "tool",
          toolCallId: message.toolCallId!,
          content: message.content,
        });
      } else {
        messages.push({ role: "user", content: message.content });
      }
    }
    return {
      model: send.policy.model,
      messages,
      thinking: send.policy.thinking,
      reasoningEffort: send.policy.reasoningEffort,
      temperature: send.policy.temperature,
      topP: send.policy.topP,
      maxTokens: send.policy.maxTokens,
      ...(!lastRound && send.policy.tools.length > 0
        ? { tools: send.policy.tools }
        : {}),
    };
  }

  private async executeCall(
    send: ActiveSend,
    call: ToolCall,
    row: Message,
  ): Promise<void> {
    const running = this.deps.store.writeTool(row.id, {
      status: "running",
      content: "",
      error: null,
      finishedAt: null,
    });
    if (running) this.publishRow(send.chatId, running);
    const startedAt = this.now();
    const result = await this.executeTool(call, {
      signal: send.controller.signal,
      now: this.now,
      engine: new URL(this.deps.engine.url),
      version: this.deps.version ?? "dev",
      budget: send.budget,
    });
    const elapsed = Math.max(0, this.now() - startedAt);
    send.budget.toolMs += elapsed;
    send.budget.resultBytes += new TextEncoder().encode(result.text).byteLength;
    if (send.terminal !== null) return;
    const message = this.deps.store.writeTool(row.id, {
      status: result.error === null ? "done" : "error",
      content: result.text,
      error: result.error,
      finishedAt: this.now(),
    });
    if (message) this.publishRow(send.chatId, message);
    if (result.error === null) {
      this.deps.log(`chat ${send.chatId} tool ${call.name} ${elapsed} ms`);
    } else {
      this.deps.log(
        `chat ${send.chatId} tool ${call.name} error: ${result.error}`,
      );
    }
  }

  private delta(
    send: ActiveSend,
    round: RoundState,
    event: Extract<ChatEvent, { kind: "reasoning" | "content" }>,
  ) {
    const contentAt = round.content.length;
    const reasoningAt = round.reasoning.length;
    this.touchTtft(round);
    if (event.kind === "content") {
      if (round.reasoningStartedAt !== null && round.thinkingMs === null) {
        round.thinkingMs = this.now() - round.reasoningStartedAt;
      }
      round.content += event.text;
    } else {
      if (round.reasoningStartedAt === null) {
        round.reasoningStartedAt = this.now();
      }
      round.reasoning += event.text;
    }
    this.publish({
      kind: "delta",
      chatId: send.chatId,
      messageId: round.messageId,
      content: event.kind === "content" ? event.text : undefined,
      contentAt,
      reasoning: event.kind === "reasoning" ? event.text : undefined,
      reasoningAt,
    });
    this.flushPartial(round);
    if (
      event.kind === "content" &&
      round.content.length > round.htmlAt &&
      this.now() - round.lastHtmlAt >= HTML_EVERY_MS
    ) {
      round.lastHtmlAt = this.now();
      round.htmlAt = round.content.length;
      this.publish({
        kind: "html",
        chatId: send.chatId,
        messageId: round.messageId,
        html: renderMarkdown(round.content),
        htmlAt: round.htmlAt,
      });
    }
  }

  private touchTtft(round: RoundState) {
    if (round.ttftMs === null) round.ttftMs = this.now() - round.startedAt;
  }

  private flushPartial(round: RoundState) {
    const now = this.now();
    const size =
      new TextEncoder().encode(round.content).byteLength +
      new TextEncoder().encode(round.reasoning).byteLength;
    if (
      now - round.lastWriteAt < WRITE_EVERY_MS &&
      size - round.lastWriteSize < WRITE_EVERY_BYTES
    ) {
      return;
    }
    if (
      this.deps.store.writeReply(round.messageId, {
        content: round.content,
        reasoning: round.reasoning,
      })
    ) {
      round.lastWriteAt = now;
      round.lastWriteSize = size;
    }
  }

  private finishFields(
    round: RoundState,
    status: TerminalStatus,
    error: string | null,
    reason = round.finishReason,
  ) {
    const finishedAt = this.now();
    const thinkingMs =
      round.thinkingMs ??
      (round.reasoningStartedAt === null
        ? null
        : finishedAt - round.reasoningStartedAt);
    return {
      status,
      error,
      finishReason: reason,
      model: this.active?.policy.model ?? null,
      finishedAt,
      ttftMs: round.ttftMs,
      thinkingMs,
      stats: status === "done" ? round.stats : null,
    };
  }

  private finishRound(
    send: ActiveSend,
    round: RoundState,
    status: TerminalStatus,
    error: string | null,
    calls: ToolCall[] | null = null,
  ): Message | null {
    try {
      this.deps.store.writeReply(round.messageId, {
        content: round.content,
        reasoning: round.reasoning,
      });
      const message = this.deps.store.finishReply(
        round.messageId,
        this.finishFields(round, status, error),
        calls,
      );
      if (message) {
        this.publish({
          kind: "html",
          chatId: send.chatId,
          messageId: round.messageId,
          html: message.html ?? "",
          htmlAt: message.content.length,
        });
        this.publishRow(send.chatId, message);
      }
      return message;
    } catch (err) {
      this.deps.log(`chat ${send.chatId} finish failed: ${describe(err)}`);
      send.terminal = "error";
      if (this.active === send) this.active = null;
      return null;
    }
  }

  private complete(send: ActiveSend, message: Message) {
    if (send.terminal !== null) return;
    send.terminal = "done";
    if (this.active === send) this.active = null;
    const chat = this.requireChat(send.chatId);
    this.publish({ kind: "done", chat: chatSummary(chat), message });
    this.logFinish(send, message);
  }

  private fail(send: ActiveSend, error: string) {
    const round = send.current;
    if (!round || send.terminal !== null) return;
    try {
      const message = this.finishRound(send, round, "error", error);
      if (!message) return;
      send.terminal = "error";
      if (this.active === send) this.active = null;
      this.publish({
        kind: "done",
        chat: chatSummary(this.requireChat(send.chatId)),
        message,
      });
      this.deps.log(`chat ${send.chatId} error: ${error}`);
    } catch (err) {
      this.deps.log(`chat ${send.chatId} finish failed: ${describe(err)}`);
      send.terminal = "error";
      if (this.active === send) this.active = null;
    }
  }

  private terminate(send: ActiveSend, status: "stopped" | "interrupted") {
    send.terminal = status;
    this.draining = send;
    send.controller.abort();
    const round = send.current;
    if (!round) return;
    let message = this.deps.store.message(round.messageId);
    if (message?.status === "streaming") {
      message = this.finishRound(send, round, status, null);
    }
    this.interruptTools(send, status);
    if (message) {
      this.publish({
        kind: "done",
        chat: chatSummary(this.requireChat(send.chatId)),
        message,
      });
    }
    this.deps.log(`chat ${send.chatId} ${status}`);
  }

  private interruptTools(send: ActiveSend, status: "stopped" | "interrupted") {
    for (const row of send.current?.toolRows ?? []) {
      const message = this.deps.store.writeTool(row.id, {
        status,
        content: TOOL_INTERRUPTED,
        error: null,
        finishedAt: this.now(),
      });
      if (message) this.publishRow(send.chatId, message);
    }
  }

  private logFinish(send: ActiveSend, message: Message) {
    const stats = message.stats;
    if (!stats) {
      this.deps.log(`chat ${send.chatId} done`);
      return;
    }
    const seconds = (
      (message.finishedAt! - send.current!.startedAt) /
      1000
    ).toFixed(1);
    const rates: string[] = [];
    if (stats.prefillMs !== null && stats.prefillMs > 0) {
      const prefill =
        ((stats.promptTokens - stats.cachedTokens) * 1000) / stats.prefillMs;
      rates.push(`prefill ${prefill.toFixed(0)} tok/s`);
    }
    if (stats.decodeMs !== null && stats.decodeMs > 0) {
      const decode = (stats.generated * 1000) / stats.decodeMs;
      rates.push(`decode ${decode.toFixed(0)} tok/s`);
    }
    rates.push(`${stats.cachedTokens} cached`);
    this.deps.log(
      `chat ${send.chatId} done ${stats.promptTokens}+${stats.generated} tokens in ${seconds} s (${rates.join(", ")})`,
    );
  }

  private systemPrompt(prompt: string, toolsEnabled: boolean): string {
    if (!toolsEnabled) return prompt;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const date = formatCurrentTime(this.now(), timezone);
    const line = `Today's date: ${date.day_of_week}, ${date.datetime.slice(0, 10)}`;
    return prompt ? `${prompt}\n\n${line}` : line;
  }

  private truncateMalformedHistory(chat: Chat) {
    for (let index = 0; index < chat.messages.length; index++) {
      const message = chat.messages[index];
      if (message.role === "tool") {
        this.deps.store.deleteFrom(chat.id, message.id);
        this.deps.log(`chat ${chat.id} truncated malformed tool history`);
        return;
      }
      const calls = message.toolCalls;
      if (!calls || calls.length === 0) continue;
      const rows = chat.messages.slice(index + 1, index + 1 + calls.length);
      const valid =
        rows.length === calls.length &&
        rows.every(
          (row, offset) =>
            row.role === "tool" && row.toolCallId === calls[offset].id,
        );
      if (!valid) {
        this.deps.store.deleteFrom(chat.id, message.id);
        this.deps.log(`chat ${chat.id} truncated malformed tool history`);
        return;
      }
      index += calls.length;
    }
  }

  private publishRow(chatId: string, message: Message) {
    const chat = this.deps.store.get(chatId);
    if (!chat) return;
    this.publish({
      kind: "row",
      chatId,
      message,
      chat: chatSummary(chat),
    });
  }

  private publish(event: ChatWsEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.deps.log(`chat listener failed: ${describe(err)}`);
      }
    }
  }

  private ensureIdle() {
    if (this.draining) {
      throw new ChatError(
        409,
        "Still cancelling the previous reply; try again in a moment",
      );
    }
    if (!this.active) return;
    const chat = this.deps.store.get(this.active.chatId);
    throw new ChatError(
      409,
      `mlx-spy is already answering in ${chat?.title || "another chat"}`,
    );
  }

  private requireChat(id: string): Chat {
    const chat = this.deps.store.get(id);
    if (!chat) throw new ChatError(404, "Chat not found");
    return chat;
  }

  private validateModel(id: string) {
    if (this.deps.models().some((model) => model.id === id)) return;
    const name = id.split("/").at(-1) || id;
    throw new ChatError(400, `${name} is not loaded anymore; pick a model`);
  }

  private validateText(text: string) {
    if (text.trim() === "") {
      throw new ChatError(400, "Message content must not be empty");
    }
    if (new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES) {
      throw new ChatError(400, "Message content must be at most 256 KB");
    }
  }
}
