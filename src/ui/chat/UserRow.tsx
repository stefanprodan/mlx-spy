// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "preact/hooks";
import type { Message } from "../../chats.ts";
import { command, copy, currentStreaming, running } from "./store.ts";

// A user message with Copy and Edit; editing swaps the text for a
// textarea and resends from that row (the server drops the rows after it).
export function UserRow({ message: m }: { message: Message }) {
  const [editing, setEditing] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) ta.current?.focus();
  }, [editing]);
  if (!editing) {
    return (
      <div class="msg user" data-id={m.id}>
        {m.content}
        <span class="uacts">
          <button type="button" onClick={() => void copy(m.content)}>
            Copy
          </button>
          <button
            type="button"
            disabled={running.value !== null}
            onClick={() => {
              if (!currentStreaming.value) setEditing(true);
            }}
          >
            Edit
          </button>
        </span>
      </div>
    );
  }
  const save = () => {
    const content = ta.current?.value.trim() ?? "";
    if (!content) return;
    void command("edit", { messageId: m.id, content });
  };
  const cancel = () => setEditing(false);
  return (
    <div class="msg user editing" data-id={m.id}>
      <textarea
        ref={ta}
        defaultValue={m.content}
        rows={Math.min(12, m.content.split("\n").length + 1)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            save();
          } else if (ev.key === "Escape") cancel();
        }}
      />
      <div class="row">
        <button type="button" class="btn" onClick={cancel}>
          Cancel
        </button>
        <button type="button" class="btn primary" onClick={save}>
          Send
        </button>
      </div>
    </div>
  );
}
