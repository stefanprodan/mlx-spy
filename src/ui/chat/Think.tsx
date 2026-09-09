// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "preact/hooks";
import type { Message } from "../../chats.ts";
import { secs } from "../format.ts";
import { Chevron } from "../icons.tsx";
import { clocks, opened, setOpen } from "./store.ts";
import type { Live } from "./stream.ts";

export const thinkLabel = (
  v: {
    thinkStart: number | null;
    thinkEnd: number | null;
    thinkMs: number | null;
  },
  done: boolean,
  now: number,
) => {
  if (done && v.thinkMs !== null) return `Thought for ${secs(v.thinkMs)}`;
  if (v.thinkStart === null) return done ? "Reasoning" : "Thinking";
  const end = v.thinkEnd ?? now;
  const word = done || v.thinkEnd !== null ? "Thought" : "Thinking";
  return `${word} for ${secs(end - v.thinkStart)}`;
};

// The reasoning block of a row. While the row streams the label counts
// the client clock every 250 ms; a finished row shows the runner's
// measurement, or the clocks this tab kept when the runner has none (a
// stop during thinking). `children` is what a folded round said before
// its calls, which sits after the reasoning.
export function Think({
  message,
  live,
  children,
}: {
  message: Message;
  live: Live | null;
  children?: preact.ComponentChildren;
}) {
  const key = `think-${message.id}`;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [live]);
  const kept = clocks.value.get(message.id);
  const v = live ?? {
    thinkStart: kept?.thinkStart ?? null,
    thinkEnd: kept?.thinkEnd ?? null,
    thinkMs: message.thinkingMs,
  };
  const reasoning = live?.reasoning ?? message.reasoning;
  return (
    <details
      class={live ? "think live" : "think"}
      data-of={message.id}
      open={opened.value.has(key)}
      onToggle={(e) => setOpen(key, e.currentTarget.open)}
    >
      <summary>
        <i class="spin" aria-hidden="true" />
        <Chevron />
        <span class="tl">{thinkLabel(v, live === null, Date.now())}</span>
      </summary>
      <div class="r">{reasoning}</div>
      {children}
    </details>
  );
}
