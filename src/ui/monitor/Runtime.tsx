// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Runtime section: the engine's residency and process from the sample
// (the live half), and facts about the host mlx-spy runs on from the
// snapshot (the static half). For a remote engine the host facts describe
// this machine, not the engine's, and the head says so.

import type { Sample } from "../../sample.ts";
import { DASH, diskSize, duration, gb, num } from "../format.ts";
import { busy, connection, type Snapshot } from "../store.ts";
import { engineLocal, engineName, runAction } from "./actions.ts";

// a fact with an optional note; the dash carries no note
function Fact({
  text,
  note = "",
  extra = "",
  mono = false,
  id,
}: {
  text: string;
  note?: string;
  extra?: string;
  mono?: boolean;
  id?: string;
}) {
  const cls = [mono ? "mono" : "", text === DASH ? "none" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <dd class={cls || undefined} id={id}>
      {text}
      {note && text !== DASH && <small>{note}</small>}
      {extra && <small>{extra}</small>}
    </dd>
  );
}

export function EngineState({ s }: { s: Sample | null }) {
  // the pill in the section head: uptime while online, else offline;
  // unknown while the socket is away, connecting before the first sample
  if (connection.value === "reconnecting") {
    return <span class="pill">unknown</span>;
  }
  if (!s) return <span class="pill">connecting</span>;
  const text = !s.engineUp
    ? "offline"
    : s.engineStartedAt == null
      ? "online"
      : `up ${duration(s.t - s.engineStartedAt)}`;
  return <span class={s.engineUp ? "pill live" : "pill err"}>{text}</span>;
}

export function RuntimeHead({
  snap,
  s,
}: {
  snap: Snapshot | null;
  s: Sample | null;
}) {
  const local = engineLocal.value;
  const canRestart =
    (snap?.engine.capabilities.includes("restart") ?? false) && local;
  return (
    <div class="shead">
      <h2>Runtime</h2>
      <EngineState s={s} />
      <span class="hint">
        {snap?.host && !local
          ? "host facts are for this machine, not the engine's"
          : ""}
      </span>
      <span class="grow" />
      <span class="btns">
        <button
          type="button"
          class="btn"
          disabled={!canRestart || busy.value !== null}
          title={
            canRestart
              ? ""
              : "restarts the engine service; only for a local engine"
          }
          onClick={() => void runAction("free", null)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="1.75"
              d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4.5h-4.5"
            />
          </svg>
          Restart engine
        </button>
      </span>
    </div>
  );
}

export function Runtime({
  snap,
  s,
}: {
  snap: Snapshot | null;
  s: Sample | null;
}) {
  const local = engineLocal.value;
  const loaded = s?.models.filter((m) => m.loaded).length ?? 0;
  // Memory and CPU come from the process table, so they need a local
  // engine; GPU busy is the engine's own gauge and works anywhere. A
  // remote engine gets the dash (the section head says why); a local one
  // that answers but has no process is worth a note.
  const pid = s?.enginePid ?? null;
  const why = s && local && s.engineUp ? "no mlx-serve process found" : "";
  const h = snap?.host ?? null;
  const cores =
    h && h.perfCores != null && h.effCores != null
      ? `${h.cpuCores} cores (${h.perfCores}P + ${h.effCores}E)`
      : h
        ? `${h.cpuCores} cores`
        : "";
  const hostMem =
    s && s.mem.hostTotal > 0
      ? {
          text: `${gb(s.mem.hostTotal, 0)} GB`,
          note: `${gb(s.mem.hostFree + s.mem.hostInactive, 0)} GB free`,
        }
      : { text: DASH, note: "" };
  return (
    <section class="card">
      <div class="facts">
        <dl>
          <dt>Engine</dt>
          <dd>
            <span>{snap ? engineName.value : ""}</span>
            <small>{pid == null ? "" : `pid ${pid}`}</small>
          </dd>
          <dt>URL</dt>
          <dd class="mono">{snap?.engine.url ?? ""}</dd>
          <dt>Weights</dt>
          <Fact
            text={s?.engineUp ? `${gb(s.mem.weights, 0)} GB` : DASH}
            note={
              loaded
                ? `${loaded} model${loaded === 1 ? "" : "s"} resident`
                : "nothing loaded"
            }
          />
          <dt>Memory</dt>
          <Fact
            text={s && pid != null ? `${gb(s.mem.procFootprint, 0)} GB` : DASH}
            note={s ? `RSS ${gb(s.mem.procRss, 0)} GB` : ""}
            extra={pid == null ? why : ""}
          />
          <dt>CPU</dt>
          <Fact
            text={
              s && pid != null && s.engineCpuPct != null
                ? `${num(s.engineCpuPct)}%`
                : DASH
            }
            note="of one core"
          />
          <dt>GPU</dt>
          <Fact text={s?.engineUp ? `${num(s.gpuPct)}%` : DASH} />
        </dl>
        <dl>
          <dt>Host</dt>
          <Fact text={h?.hostname ?? DASH} />
          <dt>OS</dt>
          <Fact text={h?.os ?? DASH} />
          <dt>Chip</dt>
          <Fact text={h?.chip ?? DASH} note={cores} />
          <dt>GPU</dt>
          <Fact text={h?.gpuCores != null ? `${h.gpuCores} cores` : DASH} />
          <dt>Memory</dt>
          <Fact text={hostMem.text} note={hostMem.note} />
          <dt>Disk</dt>
          <Fact
            text={h?.disk ? diskSize(h.disk.total) : DASH}
            note={h?.disk ? `${diskSize(h.disk.free)} free` : ""}
          />
        </dl>
      </div>
    </section>
  );
}
