// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "preact/hooks";
import type { Message } from "../../chats.ts";
import { secs, tps } from "../format.ts";
import { current, currentStreaming, lastSample, n, sendRows } from "./store.ts";

type Item = { label: string; value: string; cls?: string };

// the numbers line in the composer: the last reply's engine timings, or
// the live rate the monitor sees while a reply streams here. The line
// covers the whole send: tokens from every round, time from the first
export function statsOf(
  messages: Message[],
  streaming: boolean,
  smp: {
    requestsRunning: number;
    requestsPrefilling: number;
    prefillTps: number | null;
    decodeTps: number | null;
    inflightTokens: number;
  } | null,
  now: number,
): Item[] | null {
  const items: Item[] = [];
  if (streaming) {
    if (smp && smp.requestsRunning > 0) {
      if (smp.requestsPrefilling > 0 && smp.prefillTps) {
        items.push({
          label: "prefill",
          value: `${n(Math.round(smp.prefillTps))} tok/s`,
        });
      } else if (smp.decodeTps) {
        items.push({
          label: "decode",
          value: `${n(Math.round(smp.decodeTps))} tok/s`,
        });
      }
      if (smp.inflightTokens > 0) {
        items.push({ label: "", value: `${n(smp.inflightTokens)} tok` });
      }
    }
    const lastUser = messages.filter((m) => m.role === "user").at(-1);
    const first = messages.find(
      (m) => m.id > (lastUser?.id ?? 0) && m.role === "assistant",
    );
    if (first)
      items.push({ label: "", value: secs(now - first.createdAt), cls: "x" });
    return items;
  }
  // the last reply; a stopped or failed one has no numbers and the line
  // hides rather than show an older reply's
  const last = messages.filter((m) => m.role === "assistant").at(-1);
  const st = last?.stats;
  if (!last || !st) return null;
  const rounds = sendRows(messages, last).filter((x) => x.role === "assistant");
  const first = rounds[0] ?? last;
  const generated = rounds.reduce(
    (sum, x) => sum + (x.stats?.generated ?? 0),
    0,
  );
  if (typeof st.prefillMs === "number") {
    items.push({
      label: "prefill",
      value: tps(st.promptTokens - st.cachedTokens, st.prefillMs),
    });
  }
  if (typeof st.decodeMs === "number") {
    items.push({ label: "decode", value: tps(st.generated, st.decodeMs) });
  }
  if (st.promptTokens > 0) {
    items.push({
      label: "cache",
      value: `${Math.round((st.cachedTokens / st.promptTokens) * 100)}%`,
    });
  }
  items.push({
    label: "",
    value: `${n(Math.max(generated, st.generated))} tok`,
    cls: "x",
  });
  if (last.finishedAt !== null) {
    items.push({
      label: "",
      value: secs(last.finishedAt - first.createdAt),
      cls: "x",
    });
  }
  return items;
}

export function Stats() {
  const streaming = currentStreaming.value;
  const [, tick] = useState(0);
  // the elapsed time counts while the reply streams here
  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [streaming]);
  const items = statsOf(
    current.value?.messages ?? [],
    streaming,
    lastSample.value,
    Date.now(),
  );
  return (
    <div class="stats" hidden={items === null}>
      {(items ?? []).map((it, i) => (
        <span key={i} class={it.cls}>
          {it.label ? `${it.label} ` : ""}
          <b>{it.value}</b>
        </span>
      ))}
    </div>
  );
}
