// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "preact/hooks";
import { SendStop } from "../icons.tsx";
import { Context } from "./Context.tsx";
import { Stats } from "./Stats.tsx";
import {
  chats,
  command,
  compact,
  current,
  currentStreaming,
  editDraft,
  editor,
  modelInfo,
  note,
  running,
  send,
  settings,
  short,
} from "./store.ts";

// the textarea, the send/stop button and the lines around them
export function Composer() {
  const input = useRef<HTMLTextAreaElement>(null);
  const s = settings.value;
  const draft = editor.value;
  const text = draft.text.value;
  const mine = currentStreaming.value;
  const run = running.value;
  const elsewhere = run !== null && !mine;
  const info = s.model ? modelInfo(s.model) : null;
  const ready = info !== null && !elsewhere;
  const placeholder = elsewhere
    ? `Answering in ${chats.value.find((c) => c.id === run?.chatId)?.title || "another chat"}`
    : info
      ? `Message ${short(s.model)}`
      : s.model
        ? `${short(s.model)} is not on the engine; pick a model`
        : "Pick a model";

  const grow = () => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  };
  // the chat changed: the cursor goes back to the box
  const chatId = current.value?.id ?? null;
  useEffect(() => {
    input.current?.focus();
  }, [chatId]);
  useEffect(grow, [text]);

  const submit = async () => {
    const content = draft.text.value.trim();
    if (!content || draft.pending.value) return;
    if (content === "/compact") {
      editDraft("");
      await compact();
      return;
    }
    await send(content);
  };
  const disabled = !mine && (!ready || draft.pending.value > 0);
  return (
    <div class="composer">
      <div
        class={`note ${note.value?.kind ?? ""}`.trim()}
        hidden={note.value === null}
      >
        {note.value?.text ?? ""}
      </div>
      <Stats />
      <div class="box">
        <textarea
          id="chat-input"
          ref={input}
          rows={2}
          placeholder={placeholder}
          aria-label="Message"
          disabled={elsewhere}
          value={text}
          onInput={(ev) => {
            editDraft(ev.currentTarget.value);
            grow();
          }}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
              ev.preventDefault();
              if (!disabled && !currentStreaming.value) void submit();
            }
          }}
        />
        <button
          type="button"
          class={mine ? "send stop" : "send"}
          aria-label={mine ? "Stop" : "Send"}
          disabled={disabled}
          onClick={() => {
            if (currentStreaming.value) void command("stop");
            else void submit();
          }}
        >
          <SendStop />
        </button>
        <div class="foot">
          <span id="chat-hint">Enter to send, Shift+Enter for a new line</span>
          <Context />
        </div>
      </div>
    </div>
  );
}
