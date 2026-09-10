// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { group, when } from "../format.ts";
import { OpenRouterMark, Plus, Sliders } from "../icons.tsx";
import {
  closeConfig,
  configOpen,
  open,
  openConfig,
  openDraft,
  showDraft,
} from "./nav.ts";
import { chats, current, editor, localDrafts, runOf, short } from "./store.ts";

// the chat list, grouped by day; on a phone it is a drawer
export function List({
  open: isOpen,
  onPick,
}: {
  open: boolean;
  onPick: () => void;
}) {
  const now = Date.now();
  const config = configOpen.value;
  const cur = config ? null : (current.value?.id ?? null);
  let lastGroup = "";
  const rows: preact.JSX.Element[] = [];
  if (localDrafts.value.length > 0) {
    rows.push(<h2 key="drafts">Drafts</h2>);
    for (const d of localDrafts.value) {
      rows.push(
        <button
          key={`draft-${d.id}`}
          type="button"
          class={
            !config && d.editor === editor.value
              ? "chat-row active"
              : "chat-row"
          }
          onClick={() => {
            onPick();
            closeConfig();
            openDraft(d);
          }}
        >
          <span class="t">
            {d.editor.text.value.trim().slice(0, 80) || "New chat"}
          </span>
          <span class="m">
            {d.settings.provider === "openrouter" && <OpenRouterMark />}
            {short(d.settings.model)}
          </span>
          <span class="w">{d.editor.pending.value ? "Sending" : "Unsent"}</span>
        </button>,
      );
    }
  }
  for (const c of chats.value) {
    const g = group(c.updatedAt, now);
    if (g !== lastGroup) {
      rows.push(<h2 key={`g-${g}`}>{g}</h2>);
      lastGroup = g;
    }
    rows.push(
      <button
        key={c.id}
        type="button"
        class={c.id === cur ? "chat-row active" : "chat-row"}
        onClick={() => {
          onPick();
          if (config) {
            configOpen.value = false;
            if (c.id === current.value?.id) {
              history.pushState(null, "", `/chat/${encodeURIComponent(c.id)}`);
              return;
            }
          }
          if (c.id !== cur) void open(c.id, true);
        }}
      >
        <span class="t">{c.title || "New chat"}</span>
        <span class="m">
          {runOf(c.id) !== null && <i class="dot" />}
          {c.provider === "openrouter" && <OpenRouterMark />}
          {short(c.model)}
        </span>
        <span class="w">{when(c.updatedAt, now)}</span>
      </button>,
    );
  }
  return (
    <aside class={isOpen ? "list open" : "list"}>
      <button
        type="button"
        class="newchat"
        onClick={() => {
          onPick();
          closeConfig();
          showDraft(true);
        }}
      >
        <Plus />
        New chat
      </button>
      <div class="chats">
        {rows.length === 0 ? <p class="none">No chats yet.</p> : rows}
      </div>
      <button
        type="button"
        class={config ? "cfgbtn active" : "cfgbtn"}
        onClick={() => {
          onPick();
          openConfig(true);
        }}
      >
        <Sliders />
        Settings
      </button>
    </aside>
  );
}
