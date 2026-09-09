// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What is left of the imperative client: the glue between the store and
// the chat view in chat.ts, until the chat moves to Preact
// (plans/26.09.09-preact-plan.md, milestone 4). Deleted with it.

import { effect } from "@preact/signals";
import { mountChat } from "./chat.ts";
import { connection, listen } from "./store.ts";

export function mountChatPage() {
  const chat = mountChat();
  let connected = false;
  listen((msg) => {
    if (msg.type === "snapshot") {
      // the reconnect flag: the open chat may have finished or moved on
      chat.onSnapshot(msg.data.models, msg.data.chat, connected);
      connected = true;
    } else if (msg.type === "refresh") {
      chat.onModels(msg.data.models);
    } else if (msg.type === "chat") {
      chat.onChat(msg.data);
    } else if (msg.type === "sample") {
      chat.onSample(msg.data);
    }
  });
  effect(() => {
    if (connection.value === "reconnecting") chat.onDisconnect();
  });
}
