// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Which chat the page shows: open() with its token against a slower
// fetch from an earlier navigation, the draft, the history entries, and
// the socket events routed into the state while a fetch is in flight.

import { effect } from "@preact/signals";
import type { ChatWsEvent } from "../../chat.ts";
import type { Chat } from "../../chats.ts";
import { api } from "../api.ts";
import { connection, listen, models } from "../store.ts";
import { applyEvent } from "./events.ts";
import {
  beginNavigation,
  chatError,
  chats,
  clocks,
  current,
  defaultModel,
  draft,
  fail,
  fetchList,
  hostTimezone,
  isStreaming,
  lastChat,
  lastSample,
  modelInfo,
  navigation,
  opened,
  rememberChat,
  resetDraft,
  restoreDraft,
  running,
  setCurrent,
  setNote,
  state,
  tools,
  upsert,
} from "./store.ts";

export const chatIdFromPath = () => {
  const m = /^\/chat\/([^/]+)$/.exec(location.pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
};

// events for the chat being fetched, applied once the rows are in
let pending: ChatWsEvent[] = [];
let loading: string | null = null;
export async function open(id: string, push: boolean) {
  const token = beginNavigation();
  // events buffered for this chat since boot or a gap stay queued
  if (loading !== id) {
    loading = id;
    pending = [];
  }
  try {
    const chat = await api<Chat>(`/api/chats/${encodeURIComponent(id)}`);
    if (token !== navigation) return;
    setCurrent(chat);
    rememberChat(id);
    if (push) history.pushState(null, "", `/chat/${encodeURIComponent(id)}`);
    const queued = pending;
    loading = null;
    pending = [];
    for (const ev of queued) applyChatEvent(ev);
  } catch (err) {
    if (token !== navigation) return;
    loading = null;
    pending = [];
    fail(err);
    // a chat that is gone leaves; a passing failure keeps what is on screen
    if (err instanceof Error && err.message.startsWith("HTTP 404")) {
      showDraft(true);
    } else if (!current.value) showDraft(false);
  }
}

export function showDraft(push: boolean) {
  beginNavigation();
  // a chosen draft (New chat, a deleted or missing chat) is the new
  // starting point; a Back to /chat is not
  if (push) {
    rememberChat(null);
    resetDraft();
  }
  loading = null;
  pending = [];
  state.value = null;
  const d = draft.value;
  if (!d.model || !modelInfo(d.model)) {
    draft.value = { ...d, model: defaultModel() };
  }
  if (push) history.pushState(null, "", "/chat");
  setNote(null);
}

export function openDraft(value: Parameters<typeof restoreDraft>[0]) {
  beginNavigation();
  loading = null;
  pending = [];
  restoreDraft(value);
  state.value = null;
  rememberChat(null);
  history.pushState(null, "", "/chat");
}

export async function removeCurrent() {
  const cur = current.value;
  if (!cur) return;
  const token = navigation;
  try {
    await api(`/api/chats/${encodeURIComponent(cur.id)}`, "DELETE");
    chats.value = chats.value.filter((c) => c.id !== cur.id);
    if (token === navigation && current.value?.id === cur.id) {
      showDraft(true);
    }
  } catch (err) {
    if (token === navigation && current.value?.id === cur.id) fail(err);
  }
}

export function onChat(ev: ChatWsEvent) {
  const id = "chatId" in ev ? ev.chatId : ev.chat.id;
  if (ev.kind === "error") {
    if (running.value?.chatId === ev.chatId) running.value = null;
    chats.value = chats.value.map((chat) =>
      chat.id === ev.chatId ? { ...chat, streaming: false } : chat,
    );
    chatError(ev.chatId, ev.error);
  }
  switch (ev.kind) {
    case "started":
      running.value = { chatId: ev.chat.id, messageId: ev.message.id };
      upsert(ev.chat);
      break;
    case "done":
      // send-level: the reply may be a later round than the row started
      if (running.value?.chatId === ev.chat.id) running.value = null;
      upsert(ev.chat);
      // the work folds shut when the answer is in, on screen or not
      if ([...opened.value].some((k) => k.startsWith("work-"))) {
        opened.value = new Set(
          [...opened.value].filter((k) => !k.startsWith("work-")),
        );
      }
      break;
    case "error":
      break;
    case "row":
      upsert(ev.chat);
      break;
    case "chat":
      upsert({ ...ev.chat, streaming: isStreaming(ev.chat.id) });
      break;
    case "deleted":
      chats.value = chats.value.filter((c) => c.id !== ev.chatId);
      if (loading === ev.chatId) {
        beginNavigation();
        loading = null;
        pending = [];
        const selected = current.value?.id ?? null;
        rememberChat(selected);
        history.replaceState(
          null,
          "",
          selected ? `/chat/${encodeURIComponent(selected)}` : "/chat",
        );
      }
      if (current.value?.id === ev.chatId) showDraft(true);
      return;
  }
  if (loading !== null && id === loading) {
    pending.push(ev);
    return;
  }
  applyChatEvent(ev);
}

function applyChatEvent(ev: ChatWsEvent) {
  const id = "chatId" in ev ? ev.chatId : ev.chat.id;
  const s = state.value;
  if (!s || s.chat.id !== id) return;
  // a row leaving the live map keeps its clocks for the thinking label
  if (ev.kind === "done" || (ev.kind === "row" && ev.message.role !== "tool")) {
    const v = s.live.get(ev.message.id);
    if (v && ev.message.status !== "streaming") {
      const next = new Map(clocks.value);
      next.set(ev.message.id, {
        thinkStart: v.thinkStart,
        thinkEnd: v.thinkEnd ?? Date.now(),
      });
      clocks.value = next;
    }
  }
  const r = applyEvent(s, ev, Date.now());
  if (r.gap) {
    // a delta ahead of the text: the socket dropped some. The row in the
    // DB may lag the runner's buffer by one throttle window, so reload
    // after it, once per gap
    if (loading === null) {
      loading = id;
      const token = navigation;
      setTimeout(() => {
        if (loading === id && token === navigation) void open(id, false);
      }, 400);
    }
    return;
  }
  state.value = { ...r.state, running: running.value };
}

// phone: the list is a drawer over the conversation; desktop: it folds
// away and the choice survives a reload
export function listClosed(): boolean {
  try {
    return localStorage.getItem("chat.list") === "closed";
  } catch {
    return false;
  }
}
export function rememberList(closed: boolean) {
  try {
    localStorage.setItem("chat.list", closed ? "closed" : "open");
  } catch {}
}

// the socket and the URL, wired once by the page root
export function boot() {
  let booted = false;
  let connected = false;
  // the chat in the URL, else the one last used; buffer its events from
  // the first socket message on
  const startId = chatIdFromPath() ?? lastChat();
  const token = navigation;
  loading = startId;
  void api<{
    timezone: string;
    tools: { name: string; description: string }[];
  }>("/api/tools")
    .then((r) => {
      hostTimezone.value = r.timezone;
      tools.value = r.tools;
    })
    .catch(() => {});
  void fetchList().then(() => {
    if (token !== navigation) {
      booted = true;
      return;
    }
    if (startId) {
      // the remembered chat gets its URL, so a reload keeps it
      if (!chatIdFromPath()) {
        history.replaceState(null, "", `/chat/${encodeURIComponent(startId)}`);
      }
      void open(startId, false);
    } else {
      loading = null;
      if (models.value.length > 0) showDraft(false);
    }
    booted = true;
  });
  listen((msg) => {
    if (msg.type === "snapshot") {
      running.value = msg.data.chat;
      const s = state.value;
      if (s) state.value = { ...s, running: msg.data.chat };
      // not while a chat is being fetched: the draft would cancel it
      if (booted && !s && loading === null && !draft.value.model) {
        showDraft(false);
      }
      // after a reconnect the open chat may have finished or moved on
      if (connected && s) void open(s.chat.id, false);
      connected = true;
    } else if (msg.type === "chat") onChat(msg.data);
    else if (msg.type === "sample") lastSample.value = msg.data;
  });
  effect(() => {
    if (connection.value === "reconnecting") lastSample.value = null;
  });
  window.addEventListener("popstate", () => {
    const id = chatIdFromPath();
    if (id) void open(id, false);
    else showDraft(false);
  });
}
