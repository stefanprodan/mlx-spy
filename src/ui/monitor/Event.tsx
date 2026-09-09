// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ActionName } from "../../actions.ts";
import { busy, event } from "../store.ts";

const ACTION_LABEL: Record<ActionName, string> = {
  load: "load",
  unload: "unload",
  default: "set default",
  free: "restart engine",
  diskClear: "clear disk cache",
  historyClear: "clear history",
  requestsClear: "clear requests",
  favorite: "daily driver",
};

const fmtWhen = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function Event() {
  const running = busy.value;
  const outcome = event.value;
  if (running) {
    return <div class="event busy">{ACTION_LABEL[running]} running</div>;
  }
  if (!outcome) return <div class="event" hidden />;
  const what = `${ACTION_LABEL[outcome.action]}${
    outcome.model ? ` ${outcome.model}` : ""
  }`;
  const seconds = (outcome.ms / 1000).toFixed(1);
  return (
    <div class={outcome.ok ? "event" : "event err"}>
      <span class="when">{fmtWhen.format(outcome.t)}</span>
      {outcome.ok
        ? `${what}: ${outcome.detail} in ${seconds} s`
        : `${what} failed: ${outcome.detail}`}
    </div>
  );
}
