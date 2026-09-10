// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { group, when } from "../format.ts";
import { Plus } from "../icons.tsx";
import { open, openDraft, showDraft } from "./nav.ts";
import { chats, current, editor, localDrafts, short } from "./store.ts";

// the chat list, grouped by day; on a phone it is a drawer
export function List({
  open: isOpen,
  onPick,
}: {
  open: boolean;
  onPick: () => void;
}) {
  const now = Date.now();
  const cur = current.value?.id ?? null;
  let lastGroup = "";
  const rows: preact.JSX.Element[] = [];
  if (localDrafts.value.length > 0) {
    rows.push(<h2 key="drafts">Drafts</h2>);
    for (const d of localDrafts.value) {
      rows.push(
        <button
          key={`draft-${d.id}`}
          type="button"
          class={d.editor === editor.value ? "chat-row active" : "chat-row"}
          onClick={() => {
            onPick();
            openDraft(d);
          }}
        >
          <span class="t">
            {d.editor.text.value.trim().slice(0, 80) || "New chat"}
          </span>
          <span class="m">{short(d.settings.model)}</span>
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
          if (c.id !== cur) void open(c.id, true);
        }}
      >
        <span class="t">{c.title || "New chat"}</span>
        <span class="m">
          {c.streaming && <i class="dot" />}
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
          showDraft(true);
        }}
      >
        <Plus />
        New chat
      </button>
      <div class="chats">
        {rows.length === 0 ? <p class="none">No chats yet.</p> : rows}
      </div>
    </aside>
  );
}
