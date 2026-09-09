// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { event, pulls, snapshot } from "../store.ts";
import { ACTION_LABEL } from "./actions.ts";
import { pullError } from "./Pull.tsx";

const fmtWhen = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

type Failure = { t: number; text: string };

// A failed action, or a failed download, under the models table. A
// success needs no line: a loaded model shows in the list, a restart in
// the engine's uptime, a download in its row.
export function Event() {
  // the last event this tab saw, or the last one the server logged if
  // that is newer (a tab that was away during an action)
  const seen = event.value;
  const logged = snapshot.value?.events.at(-1) ?? null;
  const outcome =
    seen && logged ? (logged.t > seen.t ? logged : seen) : (seen ?? logged);
  const failures: Failure[] = [];
  if (outcome && !outcome.ok) {
    const what = `${ACTION_LABEL[outcome.action]}${
      outcome.model ? ` ${outcome.model}` : ""
    }`;
    failures.push({ t: outcome.t, text: `${what} failed: ${outcome.detail}` });
  }
  // the newest failed pull still in the list, and a refused button
  const failed = pulls.value.find((p) => p.status === "failed" && p.error);
  if (failed) {
    failures.push({
      t: failed.finishedAt ?? failed.updatedAt,
      text: `download ${failed.repo} failed: ${failed.error}`,
    });
  }
  const refused = pullError.value;
  if (refused) {
    failures.push({
      t: refused.t,
      text: `download ${refused.repo}: ${refused.text}`,
    });
  }
  failures.sort((a, b) => b.t - a.t);
  const last = failures[0];
  if (!last) return <div class="event" hidden />;
  return (
    <div class="event err">
      <span class="when">{fmtWhen.format(last.t)}</span>
      {last.text}
    </div>
  );
}
