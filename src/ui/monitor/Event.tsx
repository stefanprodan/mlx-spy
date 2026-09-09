// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { busy, event, snapshot } from "../store.ts";
import { ACTION_LABEL } from "./actions.ts";

const fmtWhen = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function Event() {
  const running = busy.value;
  // the last event this tab saw, or the last one the server logged if
  // that is newer (a tab that was away during an action)
  const seen = event.value;
  const logged = snapshot.value?.events.at(-1) ?? null;
  const outcome =
    seen && logged ? (logged.t > seen.t ? logged : seen) : (seen ?? logged);
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
