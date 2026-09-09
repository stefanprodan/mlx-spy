// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Range } from "../../history.ts";
import { Trash } from "../icons.tsx";
import { busy } from "../store.ts";
import { runAction } from "./actions.ts";

const RANGES: Range[] = ["1h", "6h", "24h", "7d"];

export function RangePicker({
  range,
  onPick,
}: {
  range: Range;
  onPick: (r: Range) => void;
}) {
  return (
    <div class="seg">
      {RANGES.map((r) => (
        <button
          type="button"
          key={r}
          class={r === range ? "active" : undefined}
          onClick={() => onPick(r)}
        >
          {r}
        </button>
      ))}
      <span class="sep" />
      <button
        type="button"
        class="trash"
        title="Clear history"
        aria-label="Clear history"
        disabled={busy.value !== null}
        onClick={() => void runAction("historyClear", null)}
      >
        <Trash />
      </button>
    </div>
  );
}
