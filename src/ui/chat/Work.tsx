// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Chevron } from "../icons.tsx";
import { Reply } from "./Reply.tsx";
import { opened, setOpen } from "./store.ts";
import { Think } from "./Think.tsx";
import { Tool } from "./Tool.tsx";
import type { Work as WorkNode } from "./thread.ts";

// The work before a send's reply (reasoning, tool calls, results) in one
// fold. It settles shut when the answer is in: the `done` event drops the
// group's key from the opened set (nav.ts), whether or not it is on screen.
export function Work({ node }: { node: WorkNode }) {
  return (
    <details
      class={node.live ? "work live" : "work"}
      open={opened.value.has(node.key)}
      onToggle={(e) => setOpen(node.key, e.currentTarget.open)}
    >
      <summary>
        <i class="spin" aria-hidden="true" />
        <Chevron />
        <span class="wl">{node.label}</span>
      </summary>
      <div class="wb">
        {node.items.map((item) => {
          if (item.kind === "round") {
            const reasoning = item.live?.reasoning ?? item.message.reasoning;
            return (
              <Reply
                key={item.message.id}
                message={item.message}
                live={item.live}
                think={reasoning !== ""}
                tools={item.tools}
                last={false}
                folded={item.folded}
              />
            );
          }
          if (item.kind === "think") {
            return (
              <Think
                key={`think-${item.of}`}
                message={item.message}
                live={item.live}
              />
            );
          }
          return (
            <Tool key={item.call.id} call={item.call} result={item.result} />
          );
        })}
      </div>
    </details>
  );
}
