// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message } from "../../chats.ts";
import { regenerate, running } from "./store.ts";
import { type Live, tail } from "./stream.ts";
import { Think } from "./Think.tsx";
import { Tool } from "./Tool.tsx";
import type { ToolNode } from "./thread.ts";

// the line under a reply: why it was cut, if it was, and the actions; the
// numbers sit in the composer
function cutReason(m: Message): { text: string; err?: boolean } | null {
  if (m.status === "stopped") return { text: "stopped" };
  if (m.status === "interrupted") {
    return { text: "interrupted, mlx-spy restarted" };
  }
  if (m.status === "error") {
    return { text: `error: ${m.error ?? "unknown"}`, err: true };
  }
  // the engine reports a loop as length/repetition_loop: the detail
  // decides before the bare reason does
  if (m.finishReason?.includes("repetition_loop")) {
    return { text: "stopped a repetition loop" };
  }
  if (m.finishReason?.startsWith("length"))
    return { text: "cut at max tokens" };
  if (m.finishReason === "tool_loop") {
    return { text: "stopped after repeating the same call" };
  }
  if (m.finishReason === "tool_limit") return { text: "tool limit reached" };
  return null;
}

function After({ message: m, last }: { message: Message; last: boolean }) {
  const cut = cutReason(m);
  return (
    <div class="after">
      {cut && <span class={cut.err ? "st err" : "st"}>{cut.text}</span>}
      <span class="acts">
        {m.content !== "" && (
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(m.content)}
          >
            Copy
          </button>
        )}
        {last && (
          <button
            type="button"
            disabled={running.value !== null}
            onClick={() => void regenerate()}
          >
            Regenerate
          </button>
        )}
      </span>
    </div>
  );
}

// An assistant row: the server's HTML plus the text received after it as
// a plain tail while it streams, so a code block in progress never breaks
// out of its element. A folded round (one that asked for calls) shows the
// text it wrote before them inside its think block: what the model said
// before calling is the model talking to itself.
export function Reply({
  message: m,
  live,
  think,
  tools,
  last,
  folded = false,
}: {
  message: Message;
  live: Live | null;
  think: boolean;
  tools: ToolNode[];
  last: boolean;
  folded?: boolean;
}) {
  const html = live ? live.html : (m.html ?? "");
  const content = live?.content ?? m.content;
  // the server renders the markdown: src/markdown.ts is the safety boundary
  const md = <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
  const inThink = folded && think && content !== "";
  return (
    <div class="msg assistant" data-id={m.id} data-started={m.createdAt}>
      {think && (
        <Think message={m} live={live}>
          {inThink && md}
        </Think>
      )}
      {!inThink && md}
      <div class="tail" hidden={live === null}>
        {live ? tail(live) : ""}
        <span class="cursor" />
      </div>
      <div class="tools">
        {tools.map((t) => (
          <Tool key={t.call.id} call={t.call} result={t.result} />
        ))}
      </div>
      {live === null && <After message={m} last={last} />}
    </div>
  );
}
