// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { group, when } from "../format.ts";
import { Plus } from "../icons.tsx";
import { open, showDraft } from "./nav.ts";
import { chats, current, short } from "./store.ts";

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
