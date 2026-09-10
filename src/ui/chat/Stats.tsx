// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "preact/hooks";
import { doneStats, freshSend, liveStats, type SendMemory } from "./stats.ts";
import { current, currentRun, currentStreaming, lastSample } from "./store.ts";

export function Stats() {
  const streaming = currentStreaming.value;
  const [, tick] = useState(0);
  // the elapsed time counts while the reply streams here
  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [streaming]);
  // what the line last showed, per send
  const memory = useRef<{ send: number | null; m: SendMemory }>({
    send: null,
    m: freshSend(),
  });
  const messages = current.value?.messages ?? [];
  let items: ReturnType<typeof doneStats>;
  if (streaming) {
    // per send, not per round: a tool or summary round keeps the memory
    const send = currentRun.value?.firstMessageId ?? null;
    if (memory.current.send !== send) {
      memory.current = { send, m: freshSend() };
    }
    const r = liveStats(
      memory.current.m,
      messages,
      lastSample.value,
      Date.now(),
    );
    memory.current.m = r.memory;
    items = r.items;
  } else items = doneStats(messages);
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
