// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The server-side chat runner owns every engine round and tool call after a
// browser leaves. A send is the unit of locking, stopping and events; the
// registry holds one per chat and admits as many as the cap allows.

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
import {
  type ChatEvent,
  type ChatMessageIn,
  type ChatProvider,
  type ChatRequest,
  type ChatTool,
  type Engine,
  PROVIDERS,
  type ProviderId,
  type ToolCall,
} from "./engine/types.ts";
import { renderMarkdown } from "./markdown.ts";
import type { SearchKeys, SearchProvider } from "./tools/search/types.ts";
import { dateLine, HOST_TIMEZONE } from "./tools/time.ts";
import {
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
// compaction: a reply that leaves less than the reserve in the model's
// window is followed by a summary round, and the next request starts from
// the summary (OpenCode's overflow.ts uses the same 20k); the reserve
// shrinks to a quarter of a small window (gemma 4 loads with 19,456 on
// the Studio, seen 2026-09-10), and the summary is capped to the reserve
// so its round fits the window it was triggered by
const CONTEXT_RESERVE = 20_000;
const SUMMARY_MAX_TOKENS = 4096;

function contextReserve(window: number): number {
  return Math.min(CONTEXT_RESERVE, Math.floor(window / 4));
}
const SUMMARIZE = `Summarize the conversation so far so that it can continue from the summary alone: the messages before this point are dropped and only the summary is kept. Write Markdown with these sections, terse bullets, no prose:

## Goal
What the user is after.

## Established
The facts, answers and decisions so far, with exact names, numbers, URLs, commands and code identifiers.

## Open
What is still unanswered or in progress.

Do not mention the summary process.`;
const SUMMARY_LEAD =
  "The conversation so far, summarized; the earlier messages were dropped:";

type TerminalStatus = "done" | "stopped" | "interrupted" | "error";

// A send in flight, for the snapshot and the `chatRuns` socket message.
// `firstMessageId` names the send across its rounds, `messageId` the row
// being written now. `stopping` is a send that ended but whose cancelled
// engine stream or tools have not settled: it still holds its slot, on
// the provider it runs on.
export type RunningSend = {
  chatId: string;
  provider: ProviderId;
  firstMessageId: number;
  messageId: number;
  phase: "running" | "stopping";
};

// the cap per provider (0 for a provider that is not configured) and the
// sends holding a slot; a send counts against its own provider only
export type ChatRuns = {
  limits: Record<ProviderId, number>;
  sends: RunningSend[];
};

export type ChatWsEvent =
  // deletedFrom: regenerate and edit removed that row and every later one
  // user is null for a summary round started on its own (compact)
  | {
      kind: "started";
      chat: ChatSummary;
      user: Message | null;
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
  // A terminal failure that could not be saved; no persisted row is claimed.
  | {
      kind: "error";
      chatId: string;
      firstMessageId: number;
      messageId: number;
      error: string;
      content: string;
      reasoning: string;
      html: string;
    }
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
  provider: ProviderId;
  model: string;
  systemPrompt: string;
  thinking: boolean;
  reasoningEffort: string | null;
  reasoningHistory: boolean;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  tools: ChatTool[];
  search: SearchProvider;
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
  userId: number | null;
  // the first row of the send, 0 until round one has one
  firstMessageId: number;
  // why the last finishRound() could not write the row, for fail()
  saveError: string | null;
  policy: FrozenPolicy;
  round: number;
  budget: SendBudget;
  controller: AbortController;
  terminal: TerminalStatus | null;
  rows: number[];
  current: RoundState | null;
  tools: Promise<void> | null;
  signatures: string[];
  // the round after a tool limit: no tools offered, the reply is the answer
  answering: boolean;
  // the round writes a summary row instead of a reply
  summarizing: boolean;
};

type ToolExecutor = (
  call: ToolCall,
  ctx: ToolContext,
) => Promise<{ text: string; error: string | null }>;

export type ChatRunnerDeps = {
  // the engine's URL is what the tools need (webfetch may read it)
  engine: Engine;
  // the chat providers by id; null for one that is not configured
  providers: Record<ProviderId, ChatProvider | null>;
  store: ChatStore;
  log: (line: string) => void;
  now?: () => number;
  version?: string;
  runTool?: ToolExecutor;
  searchKeys?: SearchKeys;
};

function chatSummary(chat: Chat): ChatSummary {
  return {
    id: chat.id,
    title: chat.title,
    provider: chat.provider,
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

// the calls of a round the engine cut (a length or a loop) or of the
// answer round after a tool limit are stored without being run and have
// no tool rows; they leave the row in the transcript and are dropped
// from the wire, since a call without a result is a malformed history
function ranCalls(messages: Message[], index: number): boolean {
  const next = messages[index + 1];
  return next !== undefined && next.role === "tool";
}

function lastSummary(messages: Message[], throughId: number): Message | null {
  let found: Message | null = null;
  for (const message of messages) {
    if (message.id > throughId) break;
    if (message.role === "summary" && message.status === "done") {
      found = message;
    }
  }
  return found;
}

function callSignature(calls: ToolCall[]): string {
  return JSON.stringify(
    calls.map((call) => ({ name: call.name, arguments: call.arguments })),
  );
}

export class ChatRunner {
  // the sends in flight by chat, cancelled ones included until they drain
  private readonly sends = new Map<string, ActiveSend>();
  private readonly listeners = new Set<(event: ChatWsEvent) => void>();
  private readonly runListeners = new Set<(runs: ChatRuns) => void>();
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

  // the occupied slots, in admission order; published on every change
  onRuns(fn: (runs: ChatRuns) => void): () => void {
    this.runListeners.add(fn);
    return () => this.runListeners.delete(fn);
  }

  runs(): ChatRuns {
    const sends: RunningSend[] = [];
    for (const send of this.sends.values()) {
      if (!send.current) continue;
      sends.push({
        chatId: send.chatId,
        provider: send.policy.provider,
        firstMessageId: send.firstMessageId,
        messageId: send.current.messageId,
        phase: send.terminal === null ? "running" : "stopping",
      });
    }
    return { limits: this.limits(), sends };
  }

  limits(): Record<ProviderId, number> {
    const limits = {} as Record<ProviderId, number>;
    for (const id of PROVIDERS)
      limits[id] = this.deps.providers[id]?.limit ?? 0;
    return limits;
  }

  private provider(id: ProviderId): ChatProvider {
    const provider = this.deps.providers[id];
    if (!provider) {
      throw new ChatError(
        400,
        id === "openrouter"
          ? "OpenRouter key missing; add ../secrets/openrouter.key and restart"
          : `${id} is not configured`,
      );
    }
    return provider;
  }

  list(): ChatSummary[] {
    return this.deps.store.list();
  }

  get(id: string): Chat | null {
    return this.deps.store.get(id);
  }

  create(settings: ChatSettings, title = ""): Chat {
    this.validateModel(settings.provider, settings.model);
    const chat = this.deps.store.create(settings, title);
    this.publish({ kind: "chat", chat: chatSettings(chat) });
    return chat;
  }

  update(id: string, patch: ChatPatch): (ChatSummary & ChatSettings) | null {
    if (
      this.sends.has(id) &&
      (patch.model !== undefined ||
        patch.provider !== undefined ||
        patch.toolsOff !== undefined ||
        patch.search !== undefined)
    ) {
      throw new ChatError(
        409,
        "Model, tools and search cannot change during a send",
      );
    }
    if (patch.model !== undefined || patch.provider !== undefined) {
      const chat = this.requireChat(id);
      this.validateModel(
        patch.provider ?? chat.provider,
        patch.model ?? chat.model,
      );
    }
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
    this.validateText(text);
    let chat = this.requireChat(chatId);
    this.admit(chat);
    this.validateModel(chat.provider, chat.model);
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
    const chat = this.requireChat(chatId);
    this.admit(chat);
    const user = [...chat.messages]
      .reverse()
      .find((row) => row.role === "user");
    if (!user || chat.messages.at(-1)?.id === user.id) {
      throw new ChatError(400, "The last message is not an assistant reply");
    }
    this.validateModel(chat.provider, chat.model);
    const deletedFrom = this.deps.store.deleteAfterLastUser(chatId);
    if (deletedFrom === null) {
      throw new ChatError(400, "The last message is not an assistant reply");
    }
    return this.startSend(this.requireChat(chatId), user, false, deletedFrom);
  }

  // a summary round on its own, from /compact in the composer: the next
  // reply starts from the summary the same way an automatic one does
  compact(chatId: string): { message: Message } {
    const chat = this.requireChat(chatId);
    this.admit(chat);
    this.validateModel(chat.provider, chat.model);
    this.truncateMalformedHistory(chat);
    const current = this.requireChat(chatId);
    const last = current.messages.at(-1);
    const since = lastSummary(current.messages, Number.MAX_SAFE_INTEGER);
    const fresh = current.messages.filter((row) => row.id > (since?.id ?? 0));
    if (
      !last ||
      !fresh.some((row) => row.role === "assistant" && row.status === "done")
    ) {
      throw new ChatError(400, "Nothing to summarize yet");
    }
    const send = this.newSend(current, null);
    send.summarizing = true;
    const message = this.firstRound(send);
    this.publish({
      kind: "started",
      chat: chatSummary(this.requireChat(chatId)),
      user: null,
      message,
    });
    this.deps.log(`chat ${chat.id} compact ${chat.model}`);
    void this.run(send, last.id);
    return { message };
  }

  edit(
    chatId: string,
    messageId: number,
    content: string,
  ): { user: Message; message: Message } {
    this.validateText(content);
    const chat = this.requireChat(chatId);
    this.admit(chat);
    const row = chat.messages.find((message) => message.id === messageId);
    if (row?.role !== "user") {
      throw new ChatError(400, "The message to edit must be a user message");
    }
    this.validateModel(chat.provider, chat.model);
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
    const send = this.sends.get(chatId);
    if (!send || send.terminal !== null) return;
    this.terminate(send, "stopped");
  }

  remove(chatId: string): boolean {
    this.stop(chatId);
    const removed = this.deps.store.remove(chatId);
    if (removed) this.publish({ kind: "deleted", chatId });
    return removed;
  }

  // every send is interrupted and its rows written before the database
  // closes; one failing send does not keep the others from being stopped
  shutdown(): void {
    for (const send of [...this.sends.values()]) {
      if (send.terminal !== null) continue;
      try {
        this.terminate(send, "interrupted");
      } catch (err) {
        this.deps.log(`chat ${send.chatId} interrupt failed: ${describe(err)}`);
      }
    }
  }

  private startSend(
    chat: Chat,
    user: Message,
    titleChanged: boolean,
    deletedFrom?: number,
  ): { user: Message; message: Message } {
    const send = this.newSend(chat, user.id);
    const message = this.firstRound(send);
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

  private newSend(chat: Chat, userId: number | null): ActiveSend {
    const toolsOff = new Set(chat.toolsOff ?? []);
    const enabled = TOOLS.map((tool) => tool.name).filter(
      (name) => !toolsOff.has(name),
    );
    const tools = toolSchemas(enabled, this.now());
    const policy: FrozenPolicy = {
      provider: chat.provider,
      model: chat.model,
      systemPrompt: this.systemPrompt(chat.systemPrompt),
      thinking: chat.thinking,
      reasoningEffort: chat.reasoningEffort,
      reasoningHistory: chat.reasoningHistory,
      temperature: chat.temperature,
      topP: chat.topP,
      maxTokens: chat.maxTokens,
      tools,
      search: chat.search,
    };
    const send: ActiveSend = {
      chatId: chat.id,
      userId,
      firstMessageId: 0,
      saveError: null,
      policy,
      round: 1,
      budget: {
        toolCalls: 0,
        fetches: 0,
        searches: 0,
        toolMs: 0,
        resultBytes: 0,
      },
      controller: new AbortController(),
      terminal: null,
      rows: [],
      current: null,
      tools: null,
      signatures: [],
      answering: false,
      summarizing: false,
    };
    this.sends.set(chat.id, send);
    return send;
  }

  // round one's row, made before the started event that carries it (a
  // row event before `started` would land in the page ahead of the user
  // message); a store failure here frees the slot instead of leaking it
  private firstRound(send: ActiveSend): Message {
    try {
      return this.beginRound(send, false);
    } catch (err) {
      this.release(send);
      throw err;
    }
  }

  private beginRound(send: ActiveSend, announce = true): Message {
    const startedAt = this.now();
    const message = this.deps.store.addMessage(
      send.chatId,
      send.summarizing ? "summary" : "assistant",
      {
        status: "streaming",
        model: send.policy.model,
        createdAt: startedAt,
      },
    );
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
    if (send.firstMessageId === 0) send.firstMessageId = message.id;
    // the slot's row changes before the row itself is announced
    this.publishRuns();
    if (announce) this.publishRow(send.chatId, message);
    return message;
  }

  private async run(send: ActiveSend, firstInputId: number): Promise<void> {
    let lastInputId = firstInputId;
    try {
      while (send.terminal === null) {
        const round = send.current!;
        if (send.summarizing) {
          this.deps.log(`chat ${send.chatId} summary round`);
          await this.consumeRound(
            send,
            round,
            this.summaryRequest(send, lastInputId),
          );
          if (send.terminal !== null) return;
          if (round.finishReason?.startsWith("error")) {
            this.fail(send, "engine generation failed");
            return;
          }
          if (round.content.trim() === "") {
            this.fail(send, "the summary came back empty");
            return;
          }
          this.settle(send, this.finishRound(send, round, "done", null));
          return;
        }
        this.deps.log(
          send.answering
            ? `chat ${send.chatId} answer round`
            : `chat ${send.chatId} round ${send.round} of ${MAX_ROUNDS}`,
        );
        await this.consumeRound(send, round, this.request(send, lastInputId));
        if (send.terminal !== null) return;
        const calls = round.calls;
        const reason = round.finishReason?.split("/", 1)[0] ?? null;
        if (send.answering && calls.length > 0) {
          // the model called again after being told to answer: the send
          // ends here rather than looping
          this.settle(
            send,
            this.finishRound(send, round, "done", null, calls, "tool_limit"),
          );
          return;
        }
        if (calls.length === 0) {
          if (reason === "error") {
            this.fail(send, "engine generation failed");
            return;
          }
          const message = this.finishRound(send, round, "done", null);
          if (!message) {
            this.settle(send, null);
            return;
          }
          if (this.overflowed(send, message)) {
            // the summary round shares its prefix with the reply just
            // made, so the prefill is mostly cached; the next send starts
            // from the summary and re-prefills, unavoidable
            const used = message.stats!.promptTokens + message.stats!.generated;
            this.deps.log(
              `chat ${send.chatId} context ${used} tokens, summarizing`,
            );
            lastInputId = message.id;
            send.summarizing = true;
            send.round++;
            this.beginRound(send);
            continue;
          }
          this.complete(send, message);
          return;
        }
        if (reason === "length" || reason === "error") {
          this.settle(send, this.finishRound(send, round, "done", null, calls));
          return;
        }
        if (reason !== "stop" && reason !== "tool_calls") {
          this.settle(send, this.finishRound(send, round, "done", null, calls));
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
          this.finishFields(
            send,
            round,
            "done",
            null,
            terminalReason ?? undefined,
          ),
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
        if (terminalReason === "tool_loop") {
          this.interruptTools(send, "stopped");
          this.deps.log(`chat ${send.chatId} tool loop`);
          this.complete(send, this.deps.store.message(round.messageId)!);
          return;
        }
        if (terminalReason === "tool_limit") {
          // the calls are not run; the interrupted rows stay in the context
          // so the answer round sees what was asked and that it did not run
          this.interruptTools(send, "stopped");
          this.deps.log(`chat ${send.chatId} tool limit`);
          lastInputId = toolRows.at(-1)!.id;
          this.answerRound(send);
          continue;
        }

        const tools = calls.map((call, index) =>
          this.executeCall(send, call, toolRows[index]),
        );
        // Reject promptly to abort siblings, but retain the lock until
        // every launched call has settled, including abort-ignoring tools.
        send.tools = Promise.allSettled(tools).then(() => {});
        await Promise.all(tools);
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
          this.deps.log(`chat ${send.chatId} tool limit`);
          lastInputId = toolRows.at(-1)!.id;
          this.answerRound(send);
          continue;
        }
        lastInputId = toolRows.at(-1)!.id;
        send.round++;
        this.beginRound(send);
      }
    } catch (err) {
      if (send.terminal === null) this.fail(send, describe(err));
    } finally {
      // the slot frees once every launched call has settled, abort or not
      await send.tools;
      this.release(send);
    }
  }

  private async consumeRound(
    send: ActiveSend,
    round: RoundState,
    request: ChatRequest,
  ): Promise<void> {
    const provider = this.provider(send.policy.provider);
    for await (const event of provider.chat(request, send.controller.signal)) {
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

  // One more round after a tool limit, told to answer, so the send ends
  // with text instead of a cut reason where the answer would be.
  private answerRound(send: ActiveSend) {
    send.answering = true;
    send.round++;
    this.beginRound(send);
  }

  private window(send: ActiveSend): number | null {
    const info = this.deps.providers[send.policy.provider]
      ?.models()
      .find((m) => m.id === send.policy.model);
    return info?.contextLength || null;
  }

  private overflowed(send: ActiveSend, message: Message): boolean {
    const stats = message.stats;
    const window = this.window(send);
    if (!stats || window === null) return false;
    const usable = window - contextReserve(window);
    return usable > 0 && stats.promptTokens + stats.generated >= usable;
  }

  // the summary round: the context as the next reply would see it plus
  // the instruction, no tools and no thinking, a bounded answer
  private summaryRequest(send: ActiveSend, throughId: number): ChatRequest {
    const messages = this.history(send, throughId);
    messages.push({ role: "user", content: SUMMARIZE });
    return {
      model: send.policy.model,
      messages,
      thinking: false,
      reasoningEffort: null,
      temperature: send.policy.temperature,
      topP: send.policy.topP,
      maxTokens: Math.min(
        SUMMARY_MAX_TOKENS,
        contextReserve(this.window(send) ?? Number.MAX_SAFE_INTEGER),
      ),
      cacheKey: send.chatId,
    };
  }

  private history(send: ActiveSend, throughId: number): ChatMessageIn[] {
    const chat = this.requireChat(send.chatId);
    const messages: ChatMessageIn[] = [];
    const systemPrompt = send.policy.systemPrompt;
    // on by default so the model rereads its own chain in a tool loop; a
    // Qwen 3.5 or 3.6 template renders reasoning only for the turns after
    // the last user message, so sending it for earlier turns changes how
    // they render between one user turn and the next and the engine
    // re-prefills from the first tool round of the previous turn (19.5 s
    // at 22k tokens, seen 2026-09-09); a chat opts out to keep the cache
    const reasoning = send.policy.reasoningHistory;
    if (systemPrompt !== "") {
      messages.push({ role: "system", content: systemPrompt });
    }
    // the last summary stands in for everything before it, as a user
    // message so the turns after it keep their shape; a summary that
    // failed or was stopped is skipped like the reply it never became
    const summary = lastSummary(chat.messages, throughId);
    if (summary) {
      messages.push({
        role: "user",
        content: `${SUMMARY_LEAD}\n\n${summary.content}`,
      });
    }
    chat.messages.forEach((message, index) => {
      if (message.id > throughId) return;
      if (message.role === "summary" || message.id <= (summary?.id ?? 0)) {
        return;
      }
      const toolCalls =
        message.toolCalls && ranCalls(chat.messages, index)
          ? message.toolCalls
          : null;
      if (
        message.content === "" &&
        message.reasoning === "" &&
        toolCalls === null
      ) {
        return;
      }
      if (message.role === "assistant") {
        messages.push({
          role: "assistant",
          content: toolCalls && message.content === "" ? null : message.content,
          ...(reasoning && message.reasoning
            ? { reasoning: message.reasoning }
            : {}),
          ...(toolCalls ? { toolCalls } : {}),
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
    });
    return messages;
  }

  private request(send: ActiveSend, throughId: number): ChatRequest {
    const messages = this.history(send, throughId);
    // the nudge to answer goes at the end of the context, on the last tool
    // result: an edit to the system prompt would change the token stream
    // from the start and the engine would re-prefill the whole
    // conversation (74 s at 43k tokens, seen 2026-09-09)
    if (send.round >= MAX_ROUNDS || send.answering) {
      const tail = messages.at(-1);
      if (tail && tail.role === "tool") {
        tail.content = `${tail.content}\n\n${EXHAUSTED}`;
      } else {
        messages.push({ role: "user", content: EXHAUSTED });
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
      cacheKey: send.chatId,
      // the tools stay in the last round and in the answer round: the
      // template renders them at the top of the context, so dropping them
      // (or tool_choice "none", which the engine treats the same) would
      // re-prefill everything; and a call the model makes anyway must be
      // parsed by the engine, so the round ends as tool_limit instead of
      // the raw call text becoming the answer
      ...(send.policy.tools.length > 0 ? { tools: send.policy.tools } : {}),
    };
  }

  private async executeCall(
    send: ActiveSend,
    call: ToolCall,
    row: Message,
  ): Promise<void> {
    if (send.terminal !== null) return;
    const running = this.deps.store.writeTool(row.id, {
      status: "running",
      content: "",
      error: null,
      finishedAt: null,
    });
    if (running) this.publishRow(send.chatId, running);
    if (send.terminal !== null) return;
    const startedAt = this.now();
    const result = await this.executeTool(call, {
      signal: send.controller.signal,
      now: this.now,
      engine: new URL(this.deps.engine.url),
      version: this.deps.version ?? "dev",
      search: {
        provider: send.policy.search,
        key: this.deps.searchKeys?.[send.policy.search] ?? null,
      },
      budget: send.budget,
    });
    if (send.terminal !== null) return;
    const elapsed = Math.max(0, this.now() - startedAt);
    send.budget.toolMs += elapsed;
    send.budget.resultBytes += new TextEncoder().encode(result.text).byteLength;
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
        html: renderMarkdown(round.content, true),
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
    send: ActiveSend,
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
      model: send.policy.model,
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
    reason = round.finishReason,
  ): Message | null {
    try {
      this.deps.store.writeReply(round.messageId, {
        content: round.content,
        reasoning: round.reasoning,
      });
      const message = this.deps.store.finishReply(
        round.messageId,
        this.finishFields(send, round, status, error, reason),
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
      // the caller ends the send through fail(), which tries once more and
      // then publishes the non-durable error, so the page gets a receipt
      this.deps.log(`chat ${send.chatId} finish failed: ${describe(err)}`);
      send.saveError = describe(err);
      return null;
    }
  }

  // a finished round is the send's end, or, when its row could not be
  // written, a failure with the reason the store gave
  private settle(send: ActiveSend, message: Message | null) {
    if (message) this.complete(send, message);
    else this.fail(send, send.saveError ?? "the reply could not be saved");
  }

  private complete(send: ActiveSend, message: Message) {
    if (send.terminal !== null) return;
    send.terminal = "done";
    const chat = this.requireChat(send.chatId);
    // nothing is left to drain after a completed round: the slot is free
    // from the done event on, so a listener of it can send the next
    // message, and the release follows the event on the socket
    const freed = this.free(send);
    this.publish({ kind: "done", chat: chatSummary(chat), message });
    this.logFinish(send, message);
    if (freed) this.publishRuns();
  }

  private fail(send: ActiveSend, error: string) {
    const round = send.current;
    if (!round || send.terminal !== null) return;
    send.terminal = "error";
    send.controller.abort();
    this.publishRuns();
    this.deps.log(`chat ${send.chatId} error: ${error}`);
    let message: Message | null = null;
    try {
      message =
        round.toolRows.length > 0
          ? this.deps.store.failToolGroup(round.messageId, error)
          : this.finishRound(send, round, "error", error);
      if (!message) {
        this.deps.log(
          `chat ${send.chatId} finish failed: reply was not finalized`,
        );
      }
    } catch (err) {
      this.deps.log(`chat ${send.chatId} finish failed: ${describe(err)}`);
    }
    this.interruptTools(send, "interrupted");
    if (message) {
      if (round.toolRows.length > 0) this.publishRow(send.chatId, message);
      const chat = this.deps.store.get(send.chatId);
      if (!chat) return;
      this.publish({
        kind: "done",
        chat: chatSummary(chat),
        message,
      });
    } else {
      this.publish({
        kind: "error",
        chatId: send.chatId,
        firstMessageId: send.firstMessageId,
        messageId: round.messageId,
        error: `${error} (reply could not be saved)`,
        content: round.content,
        reasoning: round.reasoning,
        html: renderMarkdown(round.content, true),
      });
    }
  }

  private terminate(send: ActiveSend, status: "stopped" | "interrupted") {
    send.terminal = status;
    send.controller.abort();
    this.publishRuns();
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
    const failures: unknown[] = [];
    for (const row of send.current?.toolRows ?? []) {
      try {
        const message = this.deps.store.writeTool(row.id, {
          status,
          content: TOOL_INTERRUPTED,
          error: null,
          finishedAt: this.now(),
        });
        if (message) this.publishRow(send.chatId, message);
      } catch (err) {
        failures.push(err);
        this.deps.log(
          `chat ${send.chatId} tool ${row.toolCallId} interrupt failed: ${describe(err)}`,
        );
      }
    }
    // A live send cannot continue with missing results; terminal cleanup
    // remains best-effort without replacing the original failure.
    if (send.terminal === null && failures.length > 0) throw failures[0];
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

  // the date goes under the prompt on every send, tools or not (OpenCode
  // does the same); a day, not a time, so the prefix holds until midnight
  private systemPrompt(prompt: string): string {
    const line = dateLine(this.now(), HOST_TIMEZONE);
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
      if (!ranCalls(chat.messages, index)) continue;
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

  // Admission, synchronous with the reservation that follows it: a chat
  // takes one send at a time, and each provider's cap counts its own
  // sends, cancelled ones included until they drain. Nothing is written
  // before it passes.
  private admit(chat: Chat) {
    const own = this.sends.get(chat.id);
    if (own) {
      if (own.terminal !== null) {
        throw new ChatError(
          409,
          "Still cancelling the previous reply; try again in a moment",
        );
      }
      throw new ChatError(409, `mlx-spy is already answering in ${chat.title}`);
    }
    const provider = chat.provider;
    const limit = this.provider(provider).limit;
    const peers = [...this.sends.values()].filter(
      (send) => send.policy.provider === provider,
    );
    if (peers.length < limit) return;
    if (peers.some((send) => send.terminal !== null)) {
      throw new ChatError(
        409,
        "Still cancelling the previous reply; try again in a moment",
      );
    }
    if (provider === "mlxserve") {
      const other = peers[0] ? this.deps.store.get(peers[0].chatId) : null;
      throw new ChatError(
        409,
        `mlx-spy is already answering in ${other?.title || "another chat"}`,
      );
    }
    throw new ChatError(
      409,
      `OpenRouter: ${limit} chat${limit === 1 ? "" : "s"} running; try again in a moment`,
    );
  }

  // an old continuation never frees a newer send's slot
  private free(send: ActiveSend): boolean {
    if (this.sends.get(send.chatId) !== send) return false;
    this.sends.delete(send.chatId);
    return true;
  }

  private release(send: ActiveSend) {
    if (this.free(send)) this.publishRuns();
  }

  private publishRuns() {
    const runs = this.runs();
    for (const listener of this.runListeners) {
      try {
        listener(runs);
      } catch (err) {
        this.deps.log(`chat runs listener failed: ${describe(err)}`);
      }
    }
  }

  private requireChat(id: string): Chat {
    const chat = this.deps.store.get(id);
    if (!chat) throw new ChatError(404, "Chat not found");
    return chat;
  }

  private validateModel(provider: ProviderId, id: string) {
    const models = this.provider(provider).models();
    if (models.some((model) => model.id === id)) return;
    const name = id.split("/").at(-1) || id;
    throw new ChatError(
      400,
      provider === "openrouter"
        ? `${name} is not in the OpenRouter list; add it in Settings or pick a model`
        : `${name} is not loaded anymore; pick a model`,
    );
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
