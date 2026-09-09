// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { current, k, modelInfo, n, settings } from "./store.ts";

// the last completed reply's prompt size against the model's window
export function Context() {
  const s = settings.value;
  const info = s.model ? modelInfo(s.model) : null;
  const last = current.value?.messages
    .slice()
    .reverse()
    .find((m) => m.role === "assistant" && m.stats);
  if (!info?.contextLength || !last?.stats) {
    return (
      <span class="ctx" hidden>
        <span class="n" />
        <span class="track">
          <i />
        </span>
      </span>
    );
  }
  const used = last.stats.promptTokens + last.stats.generated;
  const pct = Math.min(100, (used / info.contextLength) * 100).toFixed(1);
  return (
    <span
      class="ctx"
      title={`Context used by the last reply: ${n(used)} of ${n(info.contextLength)} tokens, prompt plus generated`}
    >
      <span class="n">{`${k(used)} / ${k(info.contextLength)}`}</span>
      <span class="track">
        <i style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}
