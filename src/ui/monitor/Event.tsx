// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { event, snapshot } from "../store.ts";
import { ACTION_LABEL } from "./actions.ts";

const fmtWhen = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

// A failed action, under the models table. A success needs no line: a
// loaded model shows in the list, a restart in the engine's uptime.
export function Event() {
  // the last event this tab saw, or the last one the server logged if
  // that is newer (a tab that was away during an action)
  const seen = event.value;
  const logged = snapshot.value?.events.at(-1) ?? null;
  const outcome =
    seen && logged ? (logged.t > seen.t ? logged : seen) : (seen ?? logged);
  if (!outcome || outcome.ok) return <div class="event" hidden />;
  const what = `${ACTION_LABEL[outcome.action]}${
    outcome.model ? ` ${outcome.model}` : ""
  }`;
  return (
    <div class="event err">
      <span class="when">{fmtWhen.format(outcome.t)}</span>
      {`${what} failed: ${outcome.detail}`}
    </div>
  );
}
