// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chat page's signals and the commands behind its buttons. The browser
// never talks to the engine: it loads chats over the REST routes, sends
// commands (send, stop, regenerate, edit) and watches the reply arrive
// over the shared WebSocket, reduced into `state` by events.ts.

import { computed, type Signal, signal } from "@preact/signals";
import type { ChatRuns, RunningSend } from "../../chat.ts";
import type { Chat, ChatSettings, ChatSummary, Message } from "../../chats.ts";
import type { RemoteModel } from "../../config.ts";
import type { ModelInfo, ProviderId } from "../../engine/types.ts";
import type { Sample } from "../../sample.ts";
import { api } from "../api.ts";
import { copyToClipboard } from "../clipboard.ts";
import { models, remoteModels } from "../store.ts";
import { type ChatState, stateOf } from "./events.ts";
import { groupRows } from "./thread.ts";

export const MAX_MESSAGE = 256 * 1024;
export const TOOL_NAMES = ["get_current_time", "webfetch", "websearch"];

// model ids are "<org>/<name>"; the name is enough on a page about one engine
export const short = (id: string) => id.slice(id.lastIndexOf("/") + 1);
export const gbOf = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`;
export const n = (v: number) => v.toLocaleString("en-US");
// token counts in the composer: 8K, 262K
export const k = (v: number) =>
  v < 1000 ? String(v) : `${Math.round(v / 1000)}K`;

export const chats = signal<ChatSummary[]>([]);
// null while the page shows the draft, the chat that does not exist yet
export const state = signal<ChatState | null>(null);
// settings of the draft (nothing is created until the first message)
export const draft = signal<ChatSettings>({
  provider: "mlxserve",
  model: "",
  systemPrompt: "",
  thinking: true,
  reasoningEffort: null,
  reasoningHistory: true,
  temperature: null,
  topP: null,
  maxTokens: null,
  toolsOff: [],
  search: "exa",
});
// the sends in flight anywhere and the cap, from the socket's snapshot
// and its `chatRuns` messages only: the server's registry is the one
// source of who holds a slot, cancelled sends included until they drain.
// Null until the snapshot arrives and again while reconnecting: nothing
// is sent on a picture that may be stale
export const runs = signal<ChatRuns | null>(null);
export const runOf = (chatId: string): RunningSend | null =>
  runs.value?.sends.find((run) => run.chatId === chatId) ?? null;
type Note = { text: string; kind: string } | null;
type Editor = {
  text: Signal<string>;
  note: Signal<Note>;
  pending: Signal<number>;
  revision: number;
};
const newEditor = (): Editor => ({
  text: signal(""),
  note: signal<Note>(null),
  pending: signal(0),
  revision: 0,
});
const editors = new Map<string, Editor>();
const draftEditor = signal(newEditor());
type LocalDraft = { id: number; editor: Editor; settings: ChatSettings };
export const localDrafts = signal<LocalDraft[]>([]);
let draftId = 0;
export let navigation = 0;

export function beginNavigation() {
  return ++navigation;
}

function keepDraft() {
  const target = draftEditor.value;
  const existing = localDrafts.value.find((d) => d.editor === target);
  if (
    !existing &&
    !target.text.value &&
    !target.pending.value &&
    !target.note.value
  )
    return;
  localDrafts.value = [
    { id: existing?.id ?? ++draftId, editor: target, settings: draft.value },
    ...localDrafts.value.filter((d) => d.editor !== target),
  ];
}

export function resetDraft(keep = true) {
  if (keep) keepDraft();
  draftEditor.value = newEditor();
}

export function restoreDraft(value: LocalDraft) {
  if (value.editor === draftEditor.value) return;
  keepDraft();
  draftEditor.value = value.editor;
  draft.value = value.settings;
}

function editorOf(id: string): Editor {
  let value = editors.get(id);
  if (!value) {
    value = newEditor();
    editors.set(id, value);
  }
  return value;
}

export const editor = computed(() =>
  state.value ? editorOf(state.value.chat.id) : draftEditor.value,
);
export const note = computed(() => editor.value.note.value);

export function editDraft(text: string) {
  const target = editor.value;
  target.revision++;
  target.text.value = text;
}
// the registry, fetched once; the dialog lists it with a checkbox each
export const tools = signal<{ name: string; description: string }[]>([]);
// the engine host's timezone, for the date line the runner adds with a tool on
export const hostTimezone = signal<string | null>(null);
export const lastSample = signal<Sample | null>(null);
// the think, tool and work blocks the user opened, by key, so a block
// survives its row moving between the group and the reply
export const opened = signal<ReadonlySet<string>>(new Set());
// the client clocks of replies that finished, for their thinking label
export const clocks = signal<
  ReadonlyMap<number, { thinkStart: number | null; thinkEnd: number | null }>
>(new Map());

export const current = computed(() => state.value?.chat ?? null);
export const settings = computed<ChatSettings>(
  () => current.value ?? draft.value,
);
// whether the chat offers the model any tool
export const toolsOn = computed(() => {
  const off = settings.value.toolsOff ?? [];
  return tools.value.some((t) => !off.includes(t.name));
});
export const isStreaming = (chatId: string) =>
  runOf(chatId)?.phase === "running";
// the slot of the chat on screen, if it holds one
export const currentRun = computed(() =>
  current.value ? runOf(current.value.id) : null,
);
// the reply is being written here: Stop is the button and the clock runs
export const currentStreaming = computed(() => {
  const run = currentRun.value;
  const s = state.value;
  return (
    run !== null &&
    s !== null &&
    run.phase === "running" &&
    !s.ended.has(run.messageId)
  );
});
// the slots of one provider taken and its cap; a send counts against the
// provider its chat runs on, so a full engine does not stop a hosted chat
export const slotsOf = (r: ChatRuns, provider: ProviderId) => ({
  taken: r.sends.filter((run) => run.provider === provider).length,
  limit: r.limits[provider] ?? 0,
});
// a send can start here: the slots are known, the chat holds none and
// its provider has one free
export const canSend = computed(() => {
  const r = runs.value;
  if (r === null || currentRun.value !== null) return false;
  const slots = slotsOf(r, settings.value.provider);
  return slots.taken < slots.limit;
});
export const tree = computed(() =>
  state.value ? groupRows(state.value, toolsOn.value, currentRun.value) : [],
);
// A hosted model as the page's model-shaped code sees it: always "there",
// no bytes, the catalog's window, tool use when the catalog lists it.
export const remoteInfo = (m: RemoteModel): ModelInfo => ({
  id: m.id,
  loaded: true,
  state: "remote",
  bytesResident: 0,
  bytesOnDisk: 0,
  contextLength: m.contextLength,
  capabilities: m.tools ? ["chat", "tool_use"] : ["chat"],
});
export const modelInfo = (
  provider: ProviderId,
  id: string,
): ModelInfo | null => {
  if (provider === "openrouter") {
    const m = remoteModels.value.find((r) => r.id === id);
    return m ? remoteInfo(m) : null;
  }
  return models.value.find((m) => m.id === id) ?? null;
};
export const loadedCount = () => models.value.filter((m) => m.loaded).length;

export function setNote(text: string | null, kind = "", target = editor.value) {
  target.note.value = text === null ? null : { text, kind };
}
export function fail(err: unknown, target = editor.value) {
  setNote(err instanceof Error ? err.message : String(err), "", target);
}

export function chatError(chatId: string, text: string) {
  setNote(text, "", editorOf(chatId));
}

export async function copy(content: string): Promise<boolean> {
  const target = editor.value;
  setNote(null, "", target);
  try {
    await copyToClipboard(content);
    return true;
  } catch (err) {
    fail(err, target);
    return false;
  }
}

export function setOpen(key: string, on: boolean) {
  if (opened.value.has(key) === on) return;
  const next = new Set(opened.value);
  if (on) next.add(key);
  else next.delete(key);
  opened.value = next;
}

// the chat last used, so coming back to the page from the monitor (or a
// new tab on /chat) shows it again; "New chat" and a deletion forget it
export function rememberChat(id: string | null) {
  try {
    if (id === null) localStorage.removeItem("chat.last");
    else localStorage.setItem("chat.last", id);
  } catch {}
}
export function lastChat(): string | null {
  try {
    return localStorage.getItem("chat.last");
  } catch {
    return null;
  }
}

export function upsert(c: ChatSummary) {
  chats.value = [c, ...chats.value.filter((x) => x.id !== c.id)].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

export async function fetchList() {
  try {
    chats.value = await api<ChatSummary[]>("/api/chats");
  } catch (err) {
    fail(err);
  }
}

export function setCurrent(chat: Chat) {
  state.value = stateOf(chat);
}

export async function patch(p: Partial<ChatSettings> & { title?: string }) {
  const cur = current.value;
  const target = editor.value;
  if (!cur) {
    draft.value = { ...draft.value, ...p };
    return;
  }
  try {
    const updated = await api<ChatSummary & ChatSettings>(
      `/api/chats/${encodeURIComponent(cur.id)}`,
      "PATCH",
      p,
    );
    const s = state.value;
    if (s && s.chat.id === updated.id) {
      state.value = { ...s, chat: { ...s.chat, ...updated } };
    }
    upsert({ ...updated, streaming: isStreaming(updated.id) });
  } catch (err) {
    fail(err, target);
  }
}

// a resident model first, so a new chat never cold-loads by accident: the
// daily driver if loaded, else the newest chat's model if loaded, else any
// loaded one; with nothing resident the same order without the constraint;
// with no engine model at all, the newest chat's hosted model
export function defaultModel(): { provider: ProviderId; model: string } {
  const list = models.value;
  const newest = chats.value[0];
  const last = newest?.provider === "mlxserve" ? newest.model : undefined;
  const pick = (ok: (m: ModelInfo) => boolean) =>
    list.find((m) => ok(m) && m.favorite)?.id ??
    (last && list.find((m) => ok(m) && m.id === last)?.id) ??
    list.find(ok)?.id;
  const local = pick((m) => m.loaded) ?? pick(() => true);
  if (local) return { provider: "mlxserve", model: local };
  const remote =
    (newest?.provider === "openrouter" &&
      remoteModels.value.find((m) => m.id === newest.model)?.id) ||
    remoteModels.value[0]?.id;
  return remote
    ? { provider: "openrouter", model: remote }
    : { provider: "mlxserve", model: "" };
}

// Send waits for the pair to be saved: a send racing the PATCH would run
// on the provider the chat still had
export function pickModel(provider: ProviderId, m: ModelInfo) {
  const target = editor.value;
  target.pending.value++;
  void patch({ provider, model: m.id }).finally(() => {
    target.pending.value--;
  });
  // a hosted model needs no loading; the empty transcript says where the
  // conversation goes
  if (provider === "openrouter" || m.loaded) {
    setNote(null);
    return;
  }
  const evict =
    loadedCount() >= 2
      ? " Two models are resident, so the least recently used one is evicted."
      : "";
  setNote(
    `${short(m.id)} is not loaded. The first message loads it, which takes a while.${evict}`,
    "info",
  );
}

export async function command(
  action: "messages" | "regenerate" | "edit" | "compact" | "stop",
  body?: unknown,
) {
  const cur = current.value;
  if (!cur) return;
  const target = editor.value;
  try {
    setNote(null);
    await api(
      `/api/chats/${encodeURIComponent(cur.id)}/${action}`,
      "POST",
      body ?? {},
    );
  } catch (err) {
    fail(err, target);
  }
}

// Keep the text in its own editor until accepted, so a late rejection
// never has to restore text into the currently selected chat.
export async function send(content: string): Promise<boolean> {
  let target = editor.value;
  if (target.pending.value) return false;
  let revision: number | null = target.revision;
  const token = navigation;
  let chatId = current.value?.id ?? null;
  const policy = { ...settings.value };
  if (content.length > MAX_MESSAGE) {
    setNote("The message is too long; 256 KB is the limit.");
    return false;
  }
  if (!policy.model) {
    setNote("Pick a model first.");
    return false;
  }
  target.pending.value++;
  try {
    setNote(null);
    if (chatId === null) {
      const chat = await api<Chat>("/api/chats", "POST", policy);
      chatId = chat.id;
      const origin = target;
      const existing = editors.get(chat.id);
      // The socket may expose the created chat before this response.
      // Adopt its editor if the user has already opened it.
      if (existing && existing !== origin) {
        if (existing.revision === 0) {
          existing.text.value = origin.text.value;
          existing.revision = origin.revision;
        } else revision = null;
        origin.pending.value--;
        target = existing;
        target.pending.value++;
      } else editors.set(chat.id, target);
      if (token === navigation && editor.value === target) {
        setCurrent(chat);
        rememberChat(chat.id);
        history.pushState(null, "", `/chat/${encodeURIComponent(chat.id)}`);
      }
      localDrafts.value = localDrafts.value.filter((d) => d.editor !== origin);
      if (draftEditor.value === origin) resetDraft(false);
      upsert({ ...chat, streaming: false });
    }
    await api(`/api/chats/${encodeURIComponent(chatId)}/messages`, "POST", {
      content,
    });
    if (target.revision === revision) target.text.value = "";
    return true;
  } catch (err) {
    fail(err, target);
    return false;
  } finally {
    target.pending.value--;
  }
}

// "/compact" in the composer: a summary round on its own
export async function compact() {
  if (!canSend.value) return;
  if (!current.value) {
    setNote("Nothing to summarize yet.");
    return;
  }
  await command("compact");
}

export async function regenerate() {
  if (!canSend.value) return;
  await command("regenerate");
}

// the rows of the send a message belongs to, up to that message
export function sendRows(messages: Message[], m: Message): Message[] {
  const rows: Message[] = [];
  for (const x of messages) {
    if (x.id > m.id) break;
    if (x.role === "user") rows.length = 0;
    else rows.push(x);
  }
  return rows;
}
