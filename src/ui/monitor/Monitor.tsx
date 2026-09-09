// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The monitor page. The charts load a range from /api/history and, on the
// 1h range, grow with the live samples. Longer ranges re-fetch every
// minute (their points are bucket averages, so appending raw seconds would
// be wrong). The tiles read the sample, the loaded series (their totals are
// over the range) and the memory a tab keeps of per-request values.

import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { Range, Series } from "../../history.ts";
import type { Sample } from "../../sample.ts";
import { Confirm } from "../shell/Confirm.tsx";
import { Pill } from "../shell/Pill.tsx";
import { connection, listen, sample, snapshot } from "../store.ts";
import { engineLocal, limits } from "./actions.ts";
import { Charts } from "./Charts.tsx";
import { Event } from "./Event.tsx";
import { Models } from "./Models.tsx";
import { RangePicker } from "./RangePicker.tsx";
import { RequestBar } from "./RequestBar.tsx";
import { Runtime, RuntimeHead } from "./Runtime.tsx";
import { appendLive } from "./series.ts";
import { Tiles } from "./Tiles.tsx";
import {
  apply,
  disconnect,
  initialTiles,
  PLACEHOLDER,
  seed,
  type TileMemory,
  tiles,
} from "./tiles.ts";

// the page's state, outside the component so the socket listener and the
// range loads reach it; one monitor per page
const range = signal<Range>("1h");
const series = signal<Series | null>(null);
const memory = signal<TileMemory>(initialTiles);

async function loadRange(r: Range) {
  const before = range.value;
  range.value = r;
  let body: { series: Series };
  try {
    const res = await fetch(`/api/history?range=${r}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = (await res.json()) as { series: Series };
  } catch (err) {
    // the old series stays, and so does its button
    if (range.value === r) range.value = before;
    console.warn(`history ${r}: ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (range.value !== r) return; // a later click won
  series.value = body.series;
  if (r === "1h") memory.value = seed(memory.value, body.series);
}

function onSample(s: Sample) {
  // the series first, so the tiles' range totals include this tick
  if (range.value === "1h" && series.value) {
    series.value = appendLive(series.value, s);
  }
  memory.value = apply(memory.value, s);
}

function ActivityPill({ s }: { s: Sample | null }) {
  // engine-wide: the phase only; the request bar carries the details
  if (!s) return <span class="pill">idle</span>;
  if (!s.engineUp) return <span class="pill err">unreachable</span>;
  if (s.requestsRunning > 0 || s.requestsPrefilling > 0) {
    return <span class="pill live">busy</span>;
  }
  return <span class="pill">idle</span>;
}

export function Monitor() {
  const snap = snapshot.value;
  const s = sample.value;
  const ser = series.value;
  const mem = memory.value;

  useEffect(() => {
    let connected = false;
    void loadRange("1h");
    return listen((msg) => {
      if (msg.type === "snapshot") {
        // the snapshot's sample teaches the tab like a live one; after a
        // reconnect the series has a hole: fetch it again
        if (msg.data.sample)
          memory.value = apply(memory.value, msg.data.sample);
        if (connected) void loadRange(range.value);
        connected = true;
      } else if (msg.type === "sample") {
        onSample(msg.data);
      } else if (msg.type === "event") {
        if (msg.data.action === "historyClear" && msg.data.ok) {
          // every tab forgets what it learned from the wiped series
          memory.value = initialTiles;
          void loadRange(range.value);
        }
      }
    });
  }, []);

  // the next sample is not the successor of the last one
  useEffect(() => {
    if (connection.value === "reconnecting") {
      memory.value = disconnect(memory.value);
    }
  }, [connection.value]);

  // longer ranges are bucket averages: refresh them by the minute
  useEffect(() => {
    if (range.value === "1h") return;
    const timer = window.setInterval(() => void loadRange(range.value), 60_000);
    return () => clearInterval(timer);
  }, [range.value]);

  return (
    <>
      <div class="shead">
        <h2>Stats</h2>
        <Pill />
        <span class="grow" />
        <RangePicker range={range.value} onPick={(r) => void loadRange(r)} />
      </div>
      <section class="card">
        <RequestBar />
        <Tiles
          tiles={
            s
              ? tiles(mem, s, ser, limits.value, engineLocal.value)
              : PLACEHOLDER
          }
        />
        <Charts
          t={ser?.t ?? []}
          prefill={ser?.prefillTps ?? []}
          decode={ser?.decodeTps ?? []}
        />
      </section>

      <div class="shead">
        <h2>Models</h2>
        <ActivityPill s={s} />
      </div>
      <Models snap={snap} />
      <Event />

      <RuntimeHead snap={snap} s={s} />
      <Runtime snap={snap} s={s} />
      <Confirm />
    </>
  );
}
