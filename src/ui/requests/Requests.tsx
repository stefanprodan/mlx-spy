// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import type { LastRequest } from "../../requests.ts";
import { api } from "../api.ts";
import { Event } from "../monitor/Event.tsx";
import { RequestBar } from "../monitor/RequestBar.tsx";
import { Pill } from "../shell/Pill.tsx";
import { busy, listen, snapshot } from "../store.ts";
import { Row } from "./Row.tsx";

const REQUESTS_SHOWN = 50;
// A completion and a cancellation can share a finish time, so the pair is
// the identity used by the server-backed list and the open-row state.
export const requestKey = (request: LastRequest) =>
  `${request.finishedAt}:${request.cancelled ? 1 : 0}`;
export const requests = signal<LastRequest[]>([]);

function fetchRequests() {
  void api<LastRequest[]>("/api/requests")
    .then((list) => {
      requests.value = list;
    })
    .catch(() => {});
}

// A sample can race the list fetch. Merge by identity and finish order so it
// cannot duplicate or misplace the newly finished request.
function noteRequest(last: LastRequest | null) {
  if (!last) return;
  const key = requestKey(last);
  if (requests.value.some((request) => requestKey(request) === key)) return;
  requests.value = [last, ...requests.value]
    .sort((a, b) => b.finishedAt - a.finishedAt)
    .slice(0, REQUESTS_SHOWN);
}

const Trash = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.75"
      d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"
    />
  </svg>
);

export function Requests() {
  const list = requests.value;
  const action = busy.value;
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    document.title = "mlx-spy · requests";
    // connect() runs after render, but an exceptionally fast first message
    // can still beat an effect scheduled after paint.
    if (snapshot.value) fetchRequests();
    return listen((message) => {
      if (message.type === "snapshot") {
        fetchRequests();
      } else if (message.type === "sample") {
        noteRequest(message.data.lastRequest);
      } else if (
        message.type === "event" &&
        message.data.ok &&
        (message.data.action === "requestsClear" ||
          message.data.action === "historyClear")
      ) {
        requests.value = [];
        setOpen(new Set());
      }
    });
  }, []);

  // Rows that age out or are wiped take their disclosure state with them.
  useEffect(() => {
    const keys = new Set(list.map(requestKey));
    setOpen((current) => {
      const next = new Set([...current].filter((key) => keys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [list]);

  const toggle = (key: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <>
      <div class="shead">
        <h2>Requests</h2>
        <Pill />
      </div>
      <section class="card" id="requests-live">
        <RequestBar />
      </section>
      <div class="shead">
        <h2>History</h2>
        <span class="grow" />
        <div class="seg">
          <button
            type="button"
            class="trash"
            title="Clear requests"
            aria-label="Clear requests"
            disabled={action !== null}
            onClick={() =>
              void import("../app.ts").then(({ runAction }) =>
                runAction("requestsClear", null),
              )
            }
          >
            <Trash />
          </button>
        </div>
      </div>
      <section class="card requests">
        <table id="requests" hidden={list.length === 0}>
          <thead>
            <tr>
              <th class="when">Finished</th>
              <th class="model">Model</th>
              <th class="num">Prompt</th>
              <th class="num cached">Cached</th>
              <th class="num">Generated</th>
              <th class="num wide">Prefill</th>
              <th class="num wide">Decode</th>
              <th class="num ttft">TTFT</th>
              <th class="num total">Total</th>
            </tr>
          </thead>
          <tbody>
            {list.map((request) => {
              const key = requestKey(request);
              return (
                <Row
                  key={key}
                  request={request}
                  open={open.has(key)}
                  onToggle={() => toggle(key)}
                />
              );
            })}
          </tbody>
        </table>
        <p class="blank" hidden={list.length > 0}>
          No requests yet.
        </p>
      </section>
      <Event />
    </>
  );
}
