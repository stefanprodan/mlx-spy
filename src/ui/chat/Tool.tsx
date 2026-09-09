// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { secs } from "../format.ts";
import { Chevron } from "../icons.tsx";
import { opened, setOpen } from "./store.ts";
import type { ToolNode } from "./thread.ts";

// the summary line shows one telling argument: the zone, the page, the
// query
export function shortArg(name: string, args: string): string {
  try {
    const o = JSON.parse(args || "{}") as Record<string, unknown>;
    if (name === "webfetch" && typeof o.url === "string") {
      const u = new URL(o.url);
      return u.host + (u.pathname === "/" ? "" : u.pathname);
    }
    if (name === "websearch" && typeof o.query === "string") {
      return o.query.replace(/\s+/g, " ").trim();
    }
    const v = Object.values(o).find((x) => typeof x === "string");
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

function pretty(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args || "{}"), null, 2);
  } catch {
    return args;
  }
}

// One tool call with its result row, when it has one; the result is the
// model's input, shown as text and labelled untrusted. A call without a
// row was never run: the engine cut the round, or it came in the answer
// round after a tool limit.
export function Tool({ call, result }: ToolNode) {
  const key = `tool-${call.id}`;
  const busy = result?.status === "pending" || result?.status === "running";
  const took =
    result?.status === "done" && result.finishedAt !== null
      ? secs(result.finishedAt - result.createdAt)
      : (result?.status ?? "not run");
  return (
    <details
      class={busy ? "tool live" : "tool"}
      data-call={call.id}
      open={opened.value.has(key)}
      onToggle={(e) => setOpen(key, e.currentTarget.open)}
    >
      <summary>
        <i class="spin" aria-hidden="true" />
        <Chevron />
        <span class="tn">{call.name}</span>
        <span class="ta">{shortArg(call.name, call.arguments)}</span>
        <span class={result?.status === "error" ? "td err" : "td"}>{took}</span>
      </summary>
      <div class="lbl">arguments</div>
      <div class="args">{pretty(call.arguments)}</div>
      <div class="lbl">result, untrusted</div>
      <div class="out">{result?.content ?? ""}</div>
    </details>
  );
}
