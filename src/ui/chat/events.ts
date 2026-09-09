// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chat's state and the reducer that applies one socket event to it.
// The state is replaced, never mutated, so a signal holding it changes
// identity on every event and the tree in thread.ts is recomputed from it.

import type { ChatWsEvent } from "../../chat.ts";
import type { Chat, Message } from "../../chats.ts";
import { applyDelta, applyHtml, type Live, liveOf } from "./stream.ts";

export type Running = { chatId: string; messageId: number } | null;

export type ChatState = {
  chat: Chat;
  // the rows streaming, by message id
  live: Map<number, Live>;
  // the send in flight anywhere, from the snapshot or `started`
  running: Running;
};

export function stateOf(chat: Chat, running: Running): ChatState {
  const live = new Map<number, Live>();
  for (const m of chat.messages) {
    if (m.status === "streaming") live.set(m.id, liveOf(m));
  }
  return { chat, live, running };
}

function upsert(messages: Message[], m: Message): Message[] {
  const i = messages.findIndex((x) => x.id === m.id);
  if (i === -1) return [...messages, m];
  const next = messages.slice();
  next[i] = m;
  return next;
}

function without(live: Map<number, Live>, id: number): Map<number, Live> {
  if (!live.has(id)) return live;
  const next = new Map(live);
  next.delete(id);
  return next;
}

function withLive(live: Map<number, Live>, id: number, v: Live) {
  const next = new Map(live);
  next.set(id, v);
  return next;
}

export function applyEvent(
  s: ChatState,
  ev: ChatWsEvent,
  now: number,
): { state: ChatState; gap: boolean } {
  const ok = { state: s, gap: false };
  const id = "chatId" in ev ? ev.chatId : ev.chat.id;
  switch (ev.kind) {
    case "started": {
      const running = { chatId: ev.chat.id, messageId: ev.message.id };
      if (id !== s.chat.id) return { state: { ...s, running }, gap: false };
      let messages = s.chat.messages;
      let live = s.live;
      // regenerate and edit replaced rows: drop that row and every later one
      if (ev.deletedFrom !== undefined) {
        const from = ev.deletedFrom;
        messages = messages.filter((m) => m.id < from);
        live = new Map([...live].filter(([k]) => k < from));
      }
      // a replayed `started` (a reconnect) already has its rows
      for (const m of [ev.user, ev.message]) {
        if (!messages.some((x) => x.id === m.id)) messages = [...messages, m];
      }
      if (!live.has(ev.message.id)) {
        live = withLive(live, ev.message.id, liveOf(ev.message));
      }
      return {
        state: { chat: { ...s.chat, ...ev.chat, messages }, live, running },
        gap: false,
      };
    }
    case "row": {
      if (id !== s.chat.id) return ok;
      const m = ev.message;
      const messages = upsert(s.chat.messages, m);
      let live = s.live;
      if (m.role === "assistant") {
        if (m.status === "streaming") {
          if (!live.has(m.id)) live = withLive(live, m.id, liveOf(m));
        } else live = without(live, m.id);
      }
      return {
        state: { ...s, chat: { ...s.chat, ...ev.chat, messages }, live },
        gap: false,
      };
    }
    case "delta": {
      const v = s.live.get(ev.messageId);
      if (id !== s.chat.id || !v) return ok;
      const r = applyDelta(v, ev, now);
      if (r.gap) return { state: s, gap: true };
      return {
        state: { ...s, live: withLive(s.live, ev.messageId, r.live) },
        gap: false,
      };
    }
    case "html": {
      const v = s.live.get(ev.messageId);
      if (id !== s.chat.id || !v) return ok;
      const next = applyHtml(v, ev);
      if (next === v) return ok;
      return {
        state: { ...s, live: withLive(s.live, ev.messageId, next) },
        gap: false,
      };
    }
    case "done": {
      // send-level: the reply may be a later round than the row started
      const running = s.running?.chatId === id ? null : s.running;
      if (id !== s.chat.id) return { state: { ...s, running }, gap: false };
      const messages = upsert(s.chat.messages, ev.message);
      return {
        state: {
          chat: { ...s.chat, ...ev.chat, messages },
          live: without(s.live, ev.message.id),
          running,
        },
        gap: false,
      };
    }
    case "chat": {
      if (id !== s.chat.id) return ok;
      return {
        state: { ...s, chat: { ...s.chat, ...ev.chat } },
        gap: false,
      };
    }
    case "deleted":
      return ok;
  }
}
