// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one WebSocket every page shares and the signals fed by it. A
// snapshot arrives on connect and a sample every second; the socket comes
// back two seconds after a close. Components read the signals; code that
// still handles messages by hand (the views not yet moved to Preact)
// subscribes with listen(). Nothing here touches the DOM.

import { computed, signal } from "@preact/signals";
import type { ActionEvent, ActionName } from "../actions.ts";
import type { Sample } from "../sample.ts";
import type { snapshot as snapshotOf, WsMessage } from "../web.ts";

export type Snapshot = ReturnType<typeof snapshotOf>;
export type Page = "monitor" | "requests" | "chat";
export type Connection = "connecting" | "live" | "reconnecting";

// one bundle serves three paths; the page is the one the path names
export const pageOf = (pathname: string): Page =>
  pathname === "/requests"
    ? "requests"
    : pathname === "/chat" || pathname.startsWith("/chat/")
      ? "chat"
      : "monitor";

export const connection = signal<Connection>("connecting");
export const connected = computed(() => connection.value === "live");
// the socket's first message, then /api/snapshot after an action or a
// change in residency
export const snapshot = signal<Snapshot | null>(null);
export const sample = signal<Sample | null>(null);
// The model list rides on every sample; the signal changes only when the
// residency picture does, so the table re-renders on a change, not 60
// times a minute. Its value comes from snapshots: a sample whose picture
// differs triggers the fetch of one.
export const models = signal<Sample["models"]>([]);
export const event = signal<ActionEvent | null>(null);
// The action in flight: this tab's, or the one the server reports in a
// snapshot (another tab's). Every control is disabled while it is set.
export const busy = signal<ActionName | null>(null);
let localAction = false;
export function setBusy(action: ActionName | null) {
  localAction = action !== null;
  busy.value = action;
}
export const version = computed(() => snapshot.value?.version ?? null);

export const modelsKeyOf = (list: Sample["models"]) =>
  list
    .map((m) => `${m.id}:${m.state}:${m.bytesResident}:${m.favorite ? 1 : 0}`)
    .join("|");
let modelsKey = "";
function setSnapshot(snap: Snapshot) {
  snapshot.value = snap;
  // a snapshot taken before this tab's own action registered must not
  // release the buttons early
  if (snap.running || !localAction) busy.value = snap.running;
  const key = modelsKeyOf(snap.models);
  if (key === modelsKey) return;
  modelsKey = key;
  models.value = snap.models;
}

// A fetched snapshot reaches the listeners as a `refresh` message, so the
// code that still renders by hand sees it apart from the socket's own
// snapshot (which also carries the running send and the reconnect case).
export type StoreMessage = WsMessage | { type: "refresh"; data: Snapshot };
type Listener = (msg: StoreMessage) => void;
const listeners = new Set<Listener>();
export function listen(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (msg: StoreMessage) => {
  for (const fn of listeners) fn(msg);
};

export function refreshSnapshot(): Promise<Snapshot | null> {
  return fetch("/api/snapshot")
    .then((r) => r.json())
    .then((snap: Snapshot) => {
      setSnapshot(snap);
      emit({ type: "refresh", data: snap });
      return snap;
    })
    .catch(() => null);
}

export function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    connection.value = "live";
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as WsMessage;
    if (msg.type === "snapshot") {
      setSnapshot(msg.data);
      if (msg.data.sample) sample.value = msg.data.sample;
    } else if (msg.type === "sample") {
      sample.value = msg.data;
      // a load or an eviction since the snapshot: fetch the new picture
      if (modelsKeyOf(msg.data.models) !== modelsKey) void refreshSnapshot();
    } else if (msg.type === "event") {
      event.value = msg.data;
      // another tab may have run it; the residency changed either way
      void refreshSnapshot();
    }
    emit(msg);
  };
  ws.onclose = () => {
    connection.value = "reconnecting";
    setTimeout(connect, 2000);
  };
}
