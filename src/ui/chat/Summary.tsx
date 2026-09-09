// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message } from "../../chats.ts";
import { Chevron } from "../icons.tsx";
import { k, opened, setOpen } from "./store.ts";
import { tail } from "./stream.ts";
import type { SummaryNode } from "./thread.ts";

function label(m: Message): string {
  if (m.status === "error") return `Summary failed: ${m.error ?? "unknown"}`;
  if (m.status === "stopped") return "Summary stopped";
  if (m.status === "interrupted") return "Summary interrupted";
  // the summary request's prompt is what it stood in for
  return m.stats
    ? `Summarized ${k(m.stats.promptTokens)} tokens`
    : "Summarized";
}

// A summary row in the transcript: the rows above it stay on the page,
// the next request starts from the summary. Shut by default, like the
// work folds; it opens on a click.
export function Summary({ node }: { node: SummaryNode }) {
  const m = node.message;
  const live = node.live;
  const key = `summary-${m.id}`;
  const html = live ? live.html : (m.html ?? "");
  return (
    <details
      class={live ? "work compact live" : "work compact"}
      open={opened.value.has(key)}
      onToggle={(e) => setOpen(key, e.currentTarget.open)}
    >
      <summary>
        <i class="spin" aria-hidden="true" />
        <Chevron />
        <span class="wl">{live ? "Summarizing" : label(m)}</span>
      </summary>
      <div class="wb">
        <div class="msg assistant" data-id={m.id}>
          {/* the server renders the markdown: src/markdown.ts is the safety boundary */}
          <div class="md" dangerouslySetInnerHTML={{ __html: html }} />
          <div class="tail" hidden={live === null}>
            {live ? tail(live) : ""}
            <span class="cursor" />
          </div>
        </div>
      </div>
    </details>
  );
}
