// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The server-side chat runner owns the engine stream after a browser leaves.
// It persists partial replies, fans offset-based events out to every tab, and
// allows only one generation because the local engine serves one at a time.

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
  Engine,
  ModelInfo,
} from "./engine/types.ts";
import { renderMarkdown } from "./markdown.ts";

const MAX_MESSAGE_BYTES = 256 * 1024;
const WRITE_EVERY_MS = 250;
const WRITE_EVERY_BYTES = 2048;
const HTML_EVERY_MS = 1000;

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

type Generation = {
  chatId: string;
  messageId: number;
  model: string;
  startedAt: number;
  content: string;
  reasoning: string;
  controller: AbortController;
  terminal: boolean;
  ttftMs: number | null;
  // when the first reasoning token arrived, and how long the block took
  reasoningStartedAt: number | null;
  thinkingMs: number | null;
  lastWriteAt: number;
  lastWriteSize: number;
  lastHtmlAt: number;
  htmlAt: number;
  finishReason: string | null;
  stats: MessageStats | null;
};

export type ChatRunnerDeps = {
  engine: Engine;
  store: ChatStore;
  models: () => ModelInfo[];
  log: (line: string) => void;
  now?: () => number;
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

export class ChatRunner {
  private generation: Generation | null = null;
  private draining: Generation | null = null;
  private readonly listeners = new Set<(event: ChatWsEvent) => void>();
  private readonly now: () => number;

  constructor(private readonly deps: ChatRunnerDeps) {
    this.now = deps.now ?? Date.now;
  }

  onEvent(fn: (event: ChatWsEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  running(): { chatId: string; messageId: number } | null {
    return this.generation && !this.generation.terminal
      ? {
          chatId: this.generation.chatId,
          messageId: this.generation.messageId,
        }
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
    const chat = this.requireChat(chatId);
    this.validateModel(chat.model);
    const turn = this.deps.store.transaction(() =>
      this.insertTurn(chatId, text),
    );
    return this.startReply(turn, deletedFrom);
  }

  regenerate(chatId: string): { user: Message; message: Message } {
    this.ensureIdle();
    const chat = this.requireChat(chatId);
    const last = chat.messages.at(-1);
    const user = chat.messages.at(-2);
    if (last?.role !== "assistant" || user?.role !== "user") {
      throw new ChatError(400, "The last message is not an assistant reply");
    }
    this.validateModel(chat.model);
    const turn = this.deps.store.transaction(() => {
      this.deps.store.deleteFrom(chatId, last.id);
      const current = this.requireChat(chatId);
      return {
        chat: current,
        user,
        message: this.insertReply(current),
        titleChanged: false,
      };
    });
    return this.startReply(turn, last.id);
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
    const turn = this.deps.store.transaction(() => {
      this.deps.store.deleteFrom(chatId, messageId);
      return this.insertTurn(chatId, content);
    });
    return this.startReply(turn, messageId);
  }

  stop(chatId: string): void {
    const generation = this.generation;
    if (!generation || generation.chatId !== chatId || generation.terminal) {
      return;
    }
    // The engine may need another read to observe the abort and release its
    // single slot, so a persisted terminal row is not yet an idle engine.
    if (generation.finishReason !== null) return;
    this.beginDrain(generation);
    this.finish(generation, "stopped", null);
  }

  remove(chatId: string): boolean {
    if (this.generation?.chatId === chatId) this.stop(chatId);
    const removed = this.deps.store.remove(chatId);
    if (removed) this.publish({ kind: "deleted", chatId });
    return removed;
  }

  shutdown(): void {
    const generation = this.generation;
    if (!generation || generation.terminal) return;
    this.beginDrain(generation);
    this.finish(
      generation,
      generation.finishReason === null ? "interrupted" : "done",
      null,
    );
  }

  private insertTurn(chatId: string, text: string) {
    let chat = this.requireChat(chatId);
    const titleChanged = chat.title === "" && chat.messages.length === 0;
    if (titleChanged) {
      chat = this.deps.store.update(chatId, { title: titleFrom(text) })!;
    }
    const user = this.deps.store.addMessage(chatId, "user", {
      content: text,
      status: "done",
      createdAt: this.now(),
    });
    chat = this.requireChat(chatId);
    return {
      chat,
      user,
      message: this.insertReply(chat),
      titleChanged,
    };
  }

  private insertReply(chat: Chat): Message {
    return this.deps.store.addMessage(chat.id, "assistant", {
      status: "streaming",
      model: chat.model,
      createdAt: this.now(),
    });
  }

  private startReply(
    turn: {
      chat: Chat;
      user: Message;
      message: Message;
      titleChanged: boolean;
    },
    deletedFrom?: number,
  ): { user: Message; message: Message } {
    const { chat, user, message } = turn;
    const startedAt = message.createdAt;
    const generation: Generation = {
      chatId: chat.id,
      messageId: message.id,
      model: chat.model,
      startedAt,
      content: "",
      reasoning: "",
      controller: new AbortController(),
      terminal: false,
      ttftMs: null,
      reasoningStartedAt: null,
      thinkingMs: null,
      lastWriteAt: startedAt,
      lastWriteSize: 0,
      lastHtmlAt: startedAt - HTML_EVERY_MS,
      htmlAt: 0,
      finishReason: null,
      stats: null,
    };
    this.generation = generation;
    const current = this.requireChat(chat.id);
    if (turn.titleChanged) {
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
    const request = this.request(current, user.id);
    void this.consume(generation, request);
    return { user, message };
  }

  private request(chat: Chat, throughId: number): ChatRequest {
    const messages: ChatMessageIn[] = [];
    if (chat.systemPrompt !== "") {
      messages.push({ role: "system", content: chat.systemPrompt });
    }
    for (const message of chat.messages) {
      if (message.id > throughId) break;
      if (message.content === "" && message.reasoning === "") continue;
      if (message.role === "assistant") {
        messages.push({
          role: "assistant",
          content: message.content,
          ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        });
      } else {
        messages.push({ role: "user", content: message.content });
      }
    }
    return {
      model: chat.model,
      messages,
      thinking: chat.thinking,
      reasoningEffort: chat.reasoningEffort,
      temperature: chat.temperature,
      topP: chat.topP,
      maxTokens: chat.maxTokens,
    };
  }

  private async consume(
    generation: Generation,
    request: ChatRequest,
  ): Promise<void> {
    try {
      const chat = this.deps.engine.chat;
      if (!chat)
        throw new Error(`${this.deps.engine.id} does not support chat`);
      for await (const event of chat.call(
        this.deps.engine,
        request,
        generation.controller.signal,
      )) {
        if (generation.terminal) return;
        if (event.kind === "reasoning" || event.kind === "content") {
          this.delta(generation, event);
        } else if (event.kind === "finish") {
          if (event.reason === "error") {
            this.finish(generation, "error", "engine generation failed");
            return;
          }
          generation.finishReason = finishReason(event);
        } else if (event.kind === "usage") {
          generation.stats = event.stats;
        } else {
          this.finish(generation, "error", event.message);
          return;
        }
      }
      if (generation.terminal) return;
      if (generation.finishReason === null) {
        this.finish(generation, "error", "stream ended early");
      } else {
        this.finish(generation, "done", null);
      }
    } catch (err) {
      if (!generation.terminal) {
        this.finish(generation, "error", describe(err));
      }
    } finally {
      if (this.draining === generation) this.draining = null;
    }
  }

  private delta(
    generation: Generation,
    event: Extract<ChatEvent, { kind: "reasoning" | "content" }>,
  ) {
    const contentAt = generation.content.length;
    const reasoningAt = generation.reasoning.length;
    if (generation.ttftMs === null) {
      generation.ttftMs = this.now() - generation.startedAt;
    }
    if (event.kind === "content") {
      if (
        generation.reasoningStartedAt !== null &&
        generation.thinkingMs === null
      ) {
        generation.thinkingMs = this.now() - generation.reasoningStartedAt;
      }
      generation.content += event.text;
    } else {
      if (generation.reasoningStartedAt === null) {
        generation.reasoningStartedAt = this.now();
      }
      generation.reasoning += event.text;
    }
    this.publish({
      kind: "delta",
      chatId: generation.chatId,
      messageId: generation.messageId,
      content: event.kind === "content" ? event.text : undefined,
      contentAt,
      reasoning: event.kind === "reasoning" ? event.text : undefined,
      reasoningAt,
    });
    this.flushPartial(generation);
    if (
      event.kind === "content" &&
      generation.content.length > generation.htmlAt &&
      this.now() - generation.lastHtmlAt >= HTML_EVERY_MS
    ) {
      generation.lastHtmlAt = this.now();
      generation.htmlAt = generation.content.length;
      this.publish({
        kind: "html",
        chatId: generation.chatId,
        messageId: generation.messageId,
        html: renderMarkdown(generation.content),
        htmlAt: generation.htmlAt,
      });
    }
  }

  private flushPartial(generation: Generation) {
    const now = this.now();
    const size =
      new TextEncoder().encode(generation.content).byteLength +
      new TextEncoder().encode(generation.reasoning).byteLength;
    if (
      now - generation.lastWriteAt < WRITE_EVERY_MS &&
      size - generation.lastWriteSize < WRITE_EVERY_BYTES
    ) {
      return;
    }
    if (
      this.deps.store.writeReply(generation.messageId, {
        content: generation.content,
        reasoning: generation.reasoning,
      })
    ) {
      generation.lastWriteAt = now;
      generation.lastWriteSize = size;
    }
  }

  private finish(
    generation: Generation,
    status: "done" | "stopped" | "interrupted" | "error",
    error: string | null,
  ) {
    if (generation.terminal || this.generation !== generation) return;
    generation.terminal = true;
    const finishedAt = this.now();
    try {
      this.deps.store.writeReply(generation.messageId, {
        content: generation.content,
        reasoning: generation.reasoning,
      });
      // A reply cut while still reasoning lasted until the terminal write.
      const thinkingMs =
        generation.thinkingMs ??
        (generation.reasoningStartedAt === null
          ? null
          : finishedAt - generation.reasoningStartedAt);
      const message = this.deps.store.finishReply(generation.messageId, {
        status,
        error,
        finishReason: generation.finishReason,
        model: generation.model,
        finishedAt,
        ttftMs: generation.ttftMs,
        thinkingMs,
        stats: status === "done" ? generation.stats : null,
      });
      if (!message) return;
      this.publish({
        kind: "html",
        chatId: generation.chatId,
        messageId: generation.messageId,
        html: message.html ?? "",
        htmlAt: message.content.length,
      });
      const chat = this.requireChat(generation.chatId);
      this.publish({ kind: "done", chat: chatSummary(chat), message });
      this.logFinish(generation, message, finishedAt);
    } catch (err) {
      this.deps.log(
        `chat ${generation.chatId} finish failed: ${describe(err)}`,
      );
    } finally {
      if (this.generation === generation) this.generation = null;
    }
  }

  private logFinish(
    generation: Generation,
    message: Message,
    finishedAt: number,
  ) {
    if (message.status === "stopped" || message.status === "interrupted") {
      this.deps.log(`chat ${generation.chatId} ${message.status}`);
      return;
    }
    if (message.status === "error") {
      this.deps.log(`chat ${generation.chatId} error: ${message.error}`);
      return;
    }
    const stats = message.stats;
    if (!stats) {
      this.deps.log(`chat ${generation.chatId} done`);
      return;
    }
    const seconds = ((finishedAt - generation.startedAt) / 1000).toFixed(1);
    const prefill =
      stats.prefillMs > 0
        ? ((stats.promptTokens - stats.cachedTokens) * 1000) / stats.prefillMs
        : 0;
    const decode =
      stats.decodeMs > 0 ? (stats.generated * 1000) / stats.decodeMs : 0;
    this.deps.log(
      `chat ${generation.chatId} done ${stats.promptTokens}+${stats.generated} tokens in ${seconds} s (prefill ${prefill.toFixed(0)} tok/s, decode ${decode.toFixed(0)} tok/s, ${stats.cachedTokens} cached)`,
    );
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
    if (!this.generation) return;
    const chat = this.deps.store.get(this.generation.chatId);
    throw new ChatError(
      409,
      `mlx-spy is already answering in ${chat?.title || "another chat"}`,
    );
  }

  private beginDrain(generation: Generation) {
    this.draining = generation;
    generation.controller.abort();
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
