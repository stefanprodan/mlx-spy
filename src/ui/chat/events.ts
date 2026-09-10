// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chat's state and the reducer that applies one socket event to it.
// The state is replaced, never mutated, so a signal holding it changes
// identity on every event and the tree in thread.ts is recomputed from it.

import type { ChatWsEvent } from "../../chat.ts";
import type { Chat, Message } from "../../chats.ts";
import { applyDelta, applyHtml, type Live, liveOf } from "./stream.ts";

export type ChatState = {
  chat: Chat;
  // the rows streaming, by message id
  live: Map<number, Live>;
  // the rows a `done` or `error` ended the send on: the send is over
  // for the transcript even while its slot is still held (store.ts
  // `runs`), so a finished reply never shows as working again
  ended: ReadonlySet<number>;
};

export function stateOf(chat: Chat): ChatState {
  const live = new Map<number, Live>();
  for (const m of chat.messages) {
    if (m.status === "streaming") live.set(m.id, liveOf(m));
  }
  return { chat, live, ended: new Set() };
}

function withEnded(ended: ReadonlySet<number>, id: number) {
  if (ended.has(id)) return ended;
  return new Set([...ended, id]);
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
      if (id !== s.chat.id) return ok;
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
        if (m && !messages.some((x) => x.id === m.id)) {
          messages = [...messages, m];
        }
      }
      if (!live.has(ev.message.id)) {
        live = withLive(live, ev.message.id, liveOf(ev.message));
      }
      return {
        state: { ...s, chat: { ...s.chat, ...ev.chat, messages }, live },
        gap: false,
      };
    }
    case "row": {
      if (id !== s.chat.id) return ok;
      const m = ev.message;
      const messages = upsert(s.chat.messages, m);
      let live = s.live;
      if (m.role === "assistant" || m.role === "summary") {
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
      if (id !== s.chat.id) return ok;
      const messages = upsert(s.chat.messages, ev.message);
      return {
        state: {
          chat: { ...s.chat, ...ev.chat, messages },
          live: without(s.live, ev.message.id),
          ended: withEnded(s.ended, ev.message.id),
        },
        gap: false,
      };
    }
    case "error": {
      if (id !== s.chat.id) return ok;
      return {
        state: {
          chat: {
            ...s.chat,
            streaming: false,
            messages: s.chat.messages.map((m) =>
              m.id === ev.messageId
                ? {
                    ...m,
                    status: "error",
                    error: ev.error,
                    content: ev.content,
                    reasoning: ev.reasoning,
                    html: ev.html,
                  }
                : m,
            ),
          },
          live: without(s.live, ev.messageId),
          ended: withEnded(s.ended, ev.messageId),
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
