// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Dashboard client. One WebSocket delivers a snapshot on connect and a
// sample per second; the charts load a range from /api/history and, on the
// 1h range, grow with the live samples. Longer ranges re-fetch every minute
// (their points are bucket averages, so appending raw seconds would be
// wrong). Each chart box shows the latest values in its head and, while the
// cursor is over a plot, the values at the cursor; the cursor is shared
// across charts. The socket lives in store.ts: this file subscribes to its
// signals and message stream. Being replaced page by page with Preact
// components (plans/26.09.09-preact-plan.md).

import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { effect, untracked } from "@preact/signals";
import type { ActionEvent, ActionName } from "../actions.ts";
import type { Capability } from "../engine/types.ts";
import type { Range, Series } from "../history.ts";
import type { LastRequest } from "../requests.ts";
import type { Sample } from "../sample.ts";
import { type ChatPage, mountChat } from "./chat.ts";
import { count, DASH, diskSize, gb, num } from "./format.ts";
import {
  busy,
  connection,
  event,
  listen,
  pageOf,
  refreshSnapshot,
  type Snapshot,
  snapshot,
} from "./store.ts";

const ENGINE_NAME: Record<Snapshot["engine"]["id"], string> = {
  mlxserve: "mlx-serve",
  omlx: "oMLX",
};

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const view = pageOf(location.pathname);
let chat: ChatPage | null = null;
const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- formatting ----------

// put() marks the dash so the CSS can dim it
const put = (id: string, text: string) => {
  const e = $(id);
  e.textContent = text;
  e.classList.toggle("none", text === DASH);
};
// a fact with an optional note; the dash carries no note
const fact = (id: string, text: string, note = "") => {
  const e = $(id);
  e.replaceChildren(
    text,
    ...(note && text !== DASH ? [el("small", "", note)] : []),
  );
  e.classList.toggle("none", text === DASH);
};
// ---------- tiles ----------

// Cache hit and TTFT are per finished request, so most windows carry null;
// the tile keeps the most recent value seen in this tab.
let lastCacheHit: number | null = null;
let lastCacheTok: number | null = null;
// the last request's prompt: how many tokens, how many came from the cache
let lastReq: { prompt: number; cached: number } | null = null;
let prevTok: { epoch: number; prompt: number; cached: number } | null = null;
// decode and prefill are 0 between requests; the tiles keep the last
// request's speeds
let lastDecode: number | null = null;
let lastPrefill: number | null = null;
// the rates seen while the request in flight was prefilling and decoding:
// they stay on the bar after the phase ends, unlike the tiles' live values
let reqStart: number | null = null;
let reqPrefillTps: number | null = null;
let reqDecodeTps: number | null = null;

// A fresh tab has no "last request" memory, but the history does: take the
// most recent values from the raw 1h series so a reload does not blank the
// tiles. Only fills what is still empty; a live value always wins.
let lastSample: Sample | null = null;
function seedTiles(s: Series) {
  const lastNonZero = (a: (number | null)[]) => {
    for (let i = a.length - 1; i >= 0; i--) {
      const v = a[i];
      if (v != null && v > 0) return v;
    }
    return null;
  };
  const lastSet = (a: (number | null)[]) => {
    for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i];
    return null;
  };
  lastDecode ??= lastNonZero(s.decodeTps);
  lastPrefill ??= lastNonZero(s.prefillTps);
  lastCacheHit ??= lastSet(s.cacheHitPct);
  lastCacheTok ??= lastSet(s.cacheTokenPct);
  if (!lastReq) {
    // the last tick where the prompt counter advanced within one engine run
    for (let i = s.promptTokens.length - 1; i > 0; i--) {
      if (
        s.engineUp[i - 1] === 1 &&
        s.epoch[i] === s.epoch[i - 1] &&
        s.promptTokens[i] > s.promptTokens[i - 1]
      ) {
        lastReq = {
          prompt: s.promptTokens[i] - s.promptTokens[i - 1],
          cached: s.cachedPromptTokens[i] - s.cachedPromptTokens[i - 1],
        };
        break;
      }
    }
  }
  if (lastSample) renderTiles(lastSample);
}

function setBar(id: string, pct: number, warn = 75, crit = 90) {
  const el = $(id);
  el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  el.className = `fill${pct >= crit ? " crit" : pct >= warn ? " warn" : ""}`;
}

function renderTiles(s: Sample) {
  lastSample = s;
  const decoding = (s.decodeTps ?? 0) > 0;
  if (decoding) lastDecode = s.decodeTps;
  // idle: the last request's time is the one fact there is
  const lastAt = s.lastRequest
    ? `last at ${fmtStamp.format(s.lastRequest.finishedAt)}`
    : "";
  put("t-decode", whole(lastDecode));
  $("t-decode-sub").textContent =
    lastDecode == null ? lastAt : inView("decodeTps");
  if ((s.prefillTps ?? 0) > 0) lastPrefill = s.prefillTps;
  put("t-prefill", whole(lastPrefill));
  $("t-prefill-sub").textContent =
    lastPrefill == null ? lastAt : inView("prefillTps");
  // requests over the loaded range, the counterpart of the Generated tile
  const served = rangeTotal("requestsTotal");
  const cancelled = rangeTotal("requestsCancelled");
  const ttft = inViewMean("ttftMs");
  $("t-requests").textContent = count(served);
  $("t-requests-sub").replaceChildren(
    ...(cancelled > 0
      ? [el("span", "warn", `${count(cancelled)} cancelled`), " · "]
      : []),
    served + cancelled > 0 && ttft != null
      ? `TTFT avg ${(ttft / 1000).toFixed(1)} s`
      : "",
  );
  if (s.cacheHitPct != null) lastCacheHit = s.cacheHitPct;
  if (s.cacheTokenPct != null) lastCacheTok = s.cacheTokenPct;
  // consecutive samples of one engine run only: a reconnect gap or a new
  // epoch would merge every request in between into one
  if (
    s.engineUp &&
    prevTok &&
    prevTok.epoch === s.epoch &&
    s.promptTokens > prevTok.prompt
  ) {
    lastReq = {
      prompt: s.promptTokens - prevTok.prompt,
      cached: s.cachedPromptTokens - prevTok.cached,
    };
  }
  prevTok = s.engineUp
    ? { epoch: s.epoch, prompt: s.promptTokens, cached: s.cachedPromptTokens }
    : null;
  put("t-cache", s.engineUp ? gb(s.mem.hotCacheEst, 0) : DASH);
  // the budget is per resident model, so the tile's ceiling scales with
  // them; with nothing resident the bar sits at zero against one budget
  const loaded = s.models.filter((m) => m.loaded).length;
  const hotMax =
    limits && limits.hotBytes > 0 ? limits.hotBytes * Math.max(1, loaded) : 0;
  setBar("t-cache-bar", hotMax ? (s.mem.hotCacheEst / hotMax) * 100 : 0);
  $("t-cache-track").classList.toggle("off", !hotMax || !s.engineUp);
  $("t-cache-sub").textContent =
    lastCacheHit != null
      ? `${num(lastCacheHit)}% of lookups hit`
      : hotMax
        ? loaded > 1
          ? `of ${gb(hotMax, 0)} GB for ${loaded} models`
          : `of ${gb(hotMax, 0)} GB per model`
        : "";
  const ssd = s.disk.reduce((n, d) => n + d.bytes, 0);
  const dirs = s.disk.length;
  const ssdMax =
    limits && limits.diskBytes > 0 ? limits.diskBytes * Math.max(1, dirs) : 0;
  put("t-ssd", engineLocal ? gb(ssd, 0) : DASH);
  setBar("t-ssd-bar", ssdMax ? (ssd / ssdMax) * 100 : 0);
  $("t-ssd-track").classList.toggle("off", !engineLocal || !ssdMax);
  $("t-ssd-sub").textContent = !engineLocal
    ? ""
    : ssdMax
      ? dirs > 1
        ? `of ${gb(ssdMax, 0)} GB for ${dirs} model dirs`
        : `of ${gb(ssdMax, 0)} GB per model`
      : dirs
        ? `${dirs} model dir${dirs === 1 ? "" : "s"} on disk`
        : "";
  // prompt tokens served from the cache instead of being prefilled; the
  // number worth watching, GPU busy sits at 100% under MLX regardless
  put("t-eff", num(lastCacheTok));
  setBar("t-eff-bar", lastCacheTok ?? 0, 101, 101);
  $("t-eff-sub").textContent = lastReq
    ? `${count(lastReq.cached)} of ${count(lastReq.prompt)} prompt tokens`
    : "";
  put("t-mem", gb(s.mem.procFootprint, 0));
  const total = s.mem.hostTotal;
  const avail = s.mem.hostFree + s.mem.hostInactive;
  if (total > 0) {
    setBar("t-mem-bar", (s.mem.procFootprint / total) * 100);
    $("t-mem-sub").textContent = `${gb(avail, 0)} GB free of ${gb(total, 0)}`;
  } else {
    $("t-mem-sub").textContent = "";
  }
  // tokens over the loaded range, not the engine's lifetime
  const gen = rangeTotal("generationTokens");
  const allTok = gen + rangeTotal("promptTokens");
  $("t-generated").textContent = count(gen);
  $("t-generated-sub").textContent =
    allTok > 0
      ? `${Math.round((gen / allTok) * 100)}% of ${count(allTok)} total`
      : "";
  renderServer(s);
  renderActivity(s);
  renderRequest(s);
}

// The live half of the Runtime section: the engine's residency and process.
function renderServer(s: Sample) {
  const loaded = s.models.filter((m) => m.loaded).length;
  fact(
    "engine-weights",
    s.engineUp ? `${gb(s.mem.weights, 0)} GB` : DASH,
    loaded
      ? `${loaded} model${loaded === 1 ? "" : "s"} resident`
      : "nothing loaded",
  );
  // Memory and CPU come from the process table, so they need a local
  // engine; GPU busy is the engine's own gauge and works anywhere. A
  // remote engine gets the dash (the section head says why); a local one
  // that answers but has no process is worth a note.
  const pid = s.enginePid;
  const why = engineLocal && s.engineUp ? "no mlx-serve process found" : "";
  $("engine-proc").textContent = pid == null ? "" : `pid ${pid}`;
  // the pill in the section head: uptime while online, else offline
  const es = $("engine-state");
  es.textContent = !s.engineUp
    ? "offline"
    : s.engineStartedAt == null
      ? "online"
      : `up ${duration(s.t - s.engineStartedAt)}`;
  es.className = s.engineUp ? "pill live" : "pill err";
  fact(
    "engine-mem",
    pid == null ? DASH : `${gb(s.mem.procFootprint, 0)} GB`,
    `RSS ${gb(s.mem.procRss, 0)} GB`,
  );
  if (pid == null && why) $("engine-mem").append(el("small", "", why));
  fact(
    "engine-cpu",
    pid == null || s.engineCpuPct == null ? DASH : `${num(s.engineCpuPct)}%`,
    "of one core",
  );
  put("engine-gpu", s.engineUp ? `${num(s.gpuPct)}%` : DASH);
  if (s.mem.hostTotal > 0) {
    fact(
      "host-mem",
      `${gb(s.mem.hostTotal, 0)} GB`,
      `${gb(s.mem.hostFree + s.mem.hostInactive, 0)} GB free`,
    );
  }
}

// "3d 4h", "2h 15m", "40s"
function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

// The static half: facts about the host mlx-spy runs on. For a remote
// engine they describe this machine, not the engine's, and say so.
function renderHost(snap: Snapshot) {
  const h = snap.host;
  $("host-note").textContent =
    h && !snap.engine.local
      ? "host facts are for this machine, not the engine's"
      : "";
  if (!h) {
    for (const id of [
      "host-name",
      "host-os",
      "host-chip",
      "host-gpu",
      "host-mem",
      "host-disk",
    ]) {
      put(id, DASH);
    }
    return;
  }
  put("host-name", h.hostname);
  put("host-os", h.os);
  const cores =
    h.perfCores != null && h.effCores != null
      ? `${h.cpuCores} cores (${h.perfCores}P + ${h.effCores}E)`
      : `${h.cpuCores} cores`;
  fact("host-chip", h.chip ?? DASH, cores);
  put("host-gpu", h.gpuCores != null ? `${h.gpuCores} cores` : DASH);
  fact(
    "host-disk",
    h.disk ? diskSize(h.disk.total) : DASH,
    h.disk ? `${diskSize(h.disk.free)} free` : "",
  );
}

// How much a lifetime counter grew over the loaded range: the sum of its
// steps between consecutive points, within one engine run (a restart zeroes
// the counters) and only while the engine answered (a down sample holds 0).
// A step from 0 counts: it is the first request after an engine restart.
function rangeTotal(
  k:
    | "generationTokens"
    | "promptTokens"
    | "requestsTotal"
    | "requestsCancelled",
): number {
  if (!series) return 0;
  const v = series[k];
  let sum = 0;
  for (let i = 1; i < v.length; i++) {
    if (
      series.engineUp[i] === 1 &&
      series.engineUp[i - 1] === 1 &&
      series.epoch[i] === series.epoch[i - 1] &&
      v[i] > v[i - 1]
    ) {
      sum += v[i] - v[i - 1];
    }
  }
  return sum;
}

// "avg 30 · peak 46": the mean and highest of a rate over the loaded range,
// counting only the seconds the phase was active, so idle time does not
// drag the average down
function inView(k: "decodeTps" | "prefillTps"): string {
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (const v of series?.[k] ?? []) {
    if (v == null || v <= 0) continue;
    if (v > peak) peak = v;
    sum += v;
    n++;
  }
  return n ? `avg ${whole(sum / n)} · peak ${whole(peak)}` : "";
}

// the mean TTFT over the loaded range, each point weighted by the requests
// its own mean covers; null when no request finished in view
function inViewMean(k: "ttftMs"): number | null {
  if (!series) return null;
  let sum = 0;
  let n = 0;
  const v = series[k];
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    const w = series.ttftN[i];
    if (x == null || !(w > 0)) continue;
    sum += x * w;
    n += w;
  }
  return n ? sum / n : null;
}

// "1m 12s", "45s"
function short(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

const fmtStamp = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

// The request bar: what the engine is doing now, or the last thing it did.
// In flight the numbers are engine-wide (the engine reports counts, not
// requests); finished, they are the request's own from its counter deltas.
function renderRequest(s: Sample) {
  const bar = $("req-bar");
  const cur = s.request;
  const last = s.lastRequest;
  const tps = (tokens: number, ms: number) =>
    ms > 0 ? `${whole((tokens / ms) * 1000)} tok/s` : "";
  // a phone wraps the foot: only between the parts, never inside one
  const join = (...parts: string[]) =>
    parts
      .filter(Boolean)
      .map((p) => p.replace(/ /g, "\u00a0"))
      .join(" · ");
  const label = (id: string, text: string) => {
    const e = $(id);
    e.textContent = text;
    e.hidden = text === "";
  };
  if (cur && s.engineUp) {
    // a prefilling request is counted as running too
    const open = Math.max(s.requestsRunning, s.requestsPrefilling);
    const n = Math.max(1, open);
    const prefilling = s.requestsPrefilling > 0;
    const elapsed = Math.max(1, s.t - cur.startedAt);
    const pf = cur.prefillMs;
    const dc = cur.decodeMs;
    const known = pf + dc || 1;
    $("req-state").textContent = n > 1 ? `${n} in flight` : "in flight";
    $("req-state").className = "cur-state on";
    $("req-when").textContent = fmtStamp.format(cur.startedAt);
    $("req-tokens").textContent = `${count(s.inflightTokens)} tok generating`;
    bar.className = `cur-bar running${prefilling ? " prefilling" : ""}`;
    $("req-pf").style.width = `${(pf / known) * 100}%`;
    $("req-dc").style.width = `${(dc / known) * 100}%`;
    if (cur.startedAt !== reqStart) {
      reqStart = cur.startedAt;
      reqPrefillTps = reqDecodeTps = null;
    }
    // a short prefill may publish its only rate on the tick the phase ends
    if ((s.prefillTps ?? 0) > 0 && (prefilling || reqPrefillTps === null)) {
      reqPrefillTps = s.prefillTps;
    }
    if (!prefilling && (s.decodeTps ?? 0) > 0) reqDecodeTps = s.decodeTps;
    const rate = (v: number | null) => (v ? `${whole(v)} tok/s` : "");
    label(
      "req-prefill",
      pf ? join(`prefill ${short(pf)}`, rate(reqPrefillTps)) : "",
    );
    label(
      "req-decode",
      dc ? join(`decode ${short(dc)}`, rate(reqDecodeTps)) : "",
    );
    const total = $("req-total");
    total.replaceChildren(
      `${short(elapsed)} · ${prefilling ? "prefilling" : "decoding"}`,
    );
    if (s.requestsWaiting > 0) {
      total.append(" · ", el("span", "warn", `${s.requestsWaiting} waiting`));
    }
    return;
  }
  if (!last) {
    $("req-state").textContent = "idle";
    $("req-state").className = "cur-state";
    $("req-when").textContent = "";
    $("req-tokens").textContent = "";
    bar.className = "cur-bar";
    $("req-pf").style.width = "0";
    $("req-dc").style.width = "0";
    label("req-prefill", "");
    label("req-decode", "");
    $("req-total").textContent = "No inflight requests";
    return;
  }
  const known = last.prefillMs + last.decodeMs || 1;
  $("req-state").textContent =
    last.count > 1 ? `last ${last.count} requests` : "last request";
  $("req-state").className = "cur-state";
  $("req-when").textContent = fmtStamp.format(
    last.startedAt ?? last.finishedAt,
  );
  $("req-tokens").textContent = `${count(last.generated)} tok generated`;
  bar.className = `cur-bar${last.cancelled ? " cancelled" : ""}`;
  $("req-pf").style.width = `${(last.prefillMs / known) * 100}%`;
  $("req-dc").style.width = `${(last.decodeMs / known) * 100}%`;
  // the prompt is the context the request ran with; the part the engine
  // did not compute came from the prefix cache (unknown for a cancelled
  // request, whose counters never moved)
  const prompt = last.promptTokens;
  const cached = prompt - last.prefillTokens;
  const pfEl = $("req-prefill");
  pfEl.replaceChildren(
    join(
      last.prefillMs ? `prefill ${short(last.prefillMs)}` : "",
      prompt > 0 ? `${count(prompt)} tok` : "",
    ),
  );
  // the cached share is dropped on a phone, where the line is at its widest
  if (cached > 0) {
    pfEl.append(
      el(
        "span",
        "cur-cached",
        ` · ${whole((cached / prompt) * 100)}%\u00a0cached`,
      ),
    );
  }
  // the rate is over the tokens the engine computed, not the cached ones
  if (last.prefillTokens > 0) {
    pfEl.append(
      ` · ${tps(last.prefillTokens, last.prefillMs).replace(" ", "\u00a0")}`,
    );
  }
  pfEl.hidden = pfEl.textContent === "";
  label(
    "req-decode",
    last.decodeMs
      ? join(
          `decode ${short(last.decodeMs)}`,
          tps(last.generated, last.decodeMs),
        )
      : "",
  );
  // the start is seen up to a gauge publish late: never shorter than the
  // engine's own phase times
  const span = Math.max(
    last.startedAt != null ? last.finishedAt - last.startedAt : 0,
    known,
  );
  $("req-total").textContent =
    `${short(span)} · ${last.cancelled ? "cancelled" : "done"}`;
}

// ---------- models ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text = "",
) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

// One row per model: a state dot and the id split at its last slash, the
// size and context in dim text, the engine's state word, icon buttons.
// Activity is engine-wide (the engine does not say which model is busy)
// and lives in the section head, see renderActivity.
function renderModels(snap: Snapshot) {
  // the list is empty while the engine is unreachable (the sampler drops
  // it) or when it really lists nothing; one sentence either way
  const none = $("models-empty");
  none.hidden = snap.models.length > 0;
  none.textContent =
    snap.sample && !snap.sample.engineUp
      ? "Engine unreachable."
      : "No models found.";
  const tbody = $("models").querySelector("tbody")!;
  tbody.replaceChildren(
    ...snap.models.map((m) => {
      const tr = el("tr", m.loaded ? "ready" : "");
      const slash = m.id.lastIndexOf("/");
      const name = el("td", "name");
      name.title = m.id;
      const row = el("div");
      // model ids are Hugging Face repo ids
      const link = el("a", "model", m.id.slice(slash + 1));
      link.href = `https://huggingface.co/${m.id}`;
      link.target = "_blank";
      link.rel = "noopener";
      row.append(
        el("span", `dot ${dotFor(m.state)}`),
        el("span", "owner", slash > 0 ? `${m.id.slice(0, slash)}/` : ""),
        link,
      );
      name.append(row);
      const facts = [`${gb(m.loaded ? m.bytesResident : m.bytesOnDisk)} GB`];
      if (m.contextLength != null) {
        facts.push(`${Math.round(m.contextLength / 1024)}K ctx`);
      }
      tr.append(
        name,
        el("td", "meta", facts.join(" · ")),
        el("td", `state ${m.state}`, m.state),
        modelButtons(m, snap),
      );
      return tr;
    }),
  );
  const disk = snap.disk;
  const total = disk.reduce((n, d) => n + d.bytes, 0);
  diskTotal = total;
  engineLocal = snap.engine.local;
  canDiskClear = snap.engine.capabilities.includes("diskClear") && engineLocal;
  limits = snap.engine.limits;
  loadedCount = snap.models.filter((m) => m.loaded).length;
  const can = (c: Capability) => snap.engine.capabilities.includes(c);
  setEnabled(
    $("a-free") as HTMLButtonElement,
    can("restart") && snap.engine.local,
    "restarts the engine service; only for a local engine",
  );
  if (snap.events.length) showEvent(snap.events[snap.events.length - 1]);
  if (snap.running) setBusy(snap.running);
}

// ---------- actions ----------

let diskTotal = 0;
let canDiskClear = false;
let engineName = "engine";
let engineLocal = false;
let limits: Snapshot["engine"]["limits"] = null;
let loadedCount = 0;

function setEnabled(btn: HTMLButtonElement, on: boolean, why: string) {
  btn.disabled = !on || busy.value !== null;
  btn.title = on ? "" : why;
}

const ICON = {
  play: "M5 3l9 5-9 5z",
  stop: "M4 4h8v8H4z",
  star: "M8 1.6l2 4.1 4.5.6-3.3 3.2.8 4.5L8 11.9l-4 2.1.8-4.5L1.5 6.3 6 5.7z",
};

function icon(d: string) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

function dotFor(state: string) {
  switch (state) {
    case "ready":
      return "ready";
    case "loading":
      return "loading";
    case "evicting":
      return "evicting";
    case "error":
    case "failed":
      return "error";
    default:
      return "";
  }
}

// Icon buttons with the action as tooltip and label: the favorite star on
// every model, then load for an unloaded one or unload for a resident one.
function modelButtons(m: Snapshot["models"][number], snap: Snapshot) {
  const td = el("td", "act");
  const can = (c: Capability) => snap.engine.capabilities.includes(c);
  const btn = (label: string, glyph: string, action: ActionName, cls = "") => {
    const b = el("button", `ibtn ${cls}`.trim());
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.disabled = busy.value !== null;
    b.append(icon(glyph));
    b.onclick = () => void runAction(action, m.id);
    return b;
  };
  // the star is mlx-spy's own mark, on every model, one at most
  td.append(
    m.favorite
      ? btn("Daily driver", ICON.star, "favorite", "on")
      : btn("Mark as daily driver", ICON.star, "favorite"),
  );
  if (m.loaded) {
    if (can("unload")) td.append(btn("Unload", ICON.stop, "unload", "danger"));
  } else if (can("load")) {
    td.append(btn("Load", ICON.play, "load"));
  }
  return td;
}

// The engine-wide activity in the Models head: the phase, what the running
// requests have done so far and for how long, and the queue.
// The Models head only says whether the engine is working; the request bar
// carries the details.
function renderActivity(s: Sample) {
  const pill = $("models-phase");
  if (!s.engineUp) {
    pill.textContent = "unreachable";
    pill.className = "pill err";
  } else if (s.requestsRunning > 0 || s.requestsPrefilling > 0) {
    pill.textContent = "busy";
    pill.className = "pill live";
  } else {
    pill.textContent = "idle";
    pill.className = "pill";
  }
}

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

// The dialog copy states what happens, from the engine notes: an unload
// drops the model's RAM prefix cache, a restart drops everything but the
// SSD tier, loading past the residency cap evicts the least recently used.
// The message as nodes: the model id comes from the engine and is never
// interpreted as HTML.
function confirmText(
  action: ActionName,
  model: string | null,
): (string | Node)[] {
  const loaded = loadedCount;
  const evict =
    loaded >= 2
      ? " Two models are resident, so the least recently used one is evicted."
      : "";
  const m = el("code", "", model ?? "");
  switch (action) {
    case "load":
      return [
        "Load ",
        m,
        `? Reading the weights takes a few seconds; it becomes the default model.${evict}`,
      ];
    case "default":
      return [
        "Make ",
        m,
        ` the default model? It is loaded if needed and chat requests without a model go to it.${evict}`,
      ];
    case "unload":
      return [
        "Unload ",
        m,
        "? Its weights and RAM prefix cache are freed; the SSD tier is kept. A model still resident becomes the default.",
      ];
    case "free":
      return [`Confirm ${engineName} restart`];
    case "diskClear":
      return [
        `Restart the engine service and delete the SSD cache tier (${gb(diskTotal)} GB)? Every model is unloaded and every cached prefix is gone.`,
      ];
    case "historyClear":
      return [
        "Delete the stored history? Every sample of the last 7 days is removed from mlx-spy's database and the graphs start over.",
      ];
    case "requestsClear":
      return [
        "Delete the stored requests? The list and the last request shown in the bar are removed from mlx-spy's database.",
      ];
    case "favorite":
      return []; // a toggle, no dialog
  }
}

// `diskSize` shows the "also delete the SSD tier" checkbox, unchecked; the
// answer carries its state.
function confirm(
  text: (string | Node)[],
  okLabel: string,
  diskSize?: string,
): Promise<{ ok: boolean; checked: boolean }> {
  const dlg = $("confirm") as HTMLDialogElement;
  const check = $("confirm-check") as HTMLInputElement;
  $("confirm-text").replaceChildren(...text);
  $("confirm-ok").textContent = okLabel;
  $("confirm-opt").hidden = !diskSize;
  $("confirm-opt-size").textContent = diskSize ?? "";
  check.checked = false;
  return new Promise((resolve) => {
    dlg.onclose = () =>
      resolve({ ok: dlg.returnValue === "ok", checked: check.checked });
    dlg.returnValue = "";
    dlg.showModal();
  });
}

function setBusy(action: ActionName | null) {
  busy.value = action;
  for (const b of document.querySelectorAll<HTMLButtonElement>(
    ".btn, .ibtn, .trash",
  )) {
    if (b.closest("dialog")) continue;
    b.disabled =
      action !== null || (b.classList.contains("btn") && b.title !== "");
  }
  if (action) {
    const ev = $("event");
    ev.hidden = false;
    ev.className = "event busy";
    ev.textContent = `${ACTION_LABEL[action]} running`;
  }
}

const fmtWhen = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function showEvent(e: ActionEvent) {
  const ev = $("event");
  ev.hidden = false;
  ev.className = e.ok ? "event" : "event err";
  const what = `${ACTION_LABEL[e.action]}${e.model ? ` ${e.model}` : ""}`;
  const secs = (e.ms / 1000).toFixed(1);
  ev.replaceChildren(
    el("span", "when", fmtWhen.format(new Date(e.t))),
    document.createTextNode(
      e.ok
        ? `${what}: ${e.detail} in ${secs} s`
        : `${what} failed: ${e.detail}`,
    ),
  );
}

async function runAction(action: ActionName, model: string | null) {
  if (busy.value) return;
  const label = ACTION_LABEL[action];
  if (action !== "favorite") {
    // the restart dialog offers the disk wipe as an option: diskClear is a
    // restart plus the deletion of the SSD tier
    const a = await confirm(
      confirmText(action, model),
      label[0].toUpperCase() + label.slice(1),
      action === "free" && canDiskClear ? `${gb(diskTotal, 0)} GB` : undefined,
    );
    if (!a.ok) return;
    if (a.checked) action = "diskClear";
  }
  setBusy(action);
  try {
    const res = await fetch(`/api/actions/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(model ? { model } : {}),
    });
    const body = (await res.json()) as ActionEvent | { error: string };
    if (!res.ok) {
      event.value = {
        t: Date.now(),
        action,
        model,
        ok: false,
        ms: 0,
        detail: (body as { error: string }).error ?? `HTTP ${res.status}`,
      };
    }
    // a 200 carries the event; the /ws push shows it in every tab
  } catch (err) {
    event.value = {
      t: Date.now(),
      action,
      model,
      ok: false,
      ms: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    setBusy(null);
    void refreshSnapshot();
  }
}

// ---------- the Requests page ----------

// The last finished requests, newest first, as the server keeps them; a
// sample whose last request is not the head is a new one to prepend.
let reqs: LastRequest[] = [];
const REQUESTS_SHOWN = 50;
// a completion and a cancel can share a finish time: the pair is the key
const reqKey = (r: LastRequest) => `${r.finishedAt}:${r.cancelled ? 1 : 0}`;
// rows the user opened: a phone hides most columns and a tap shows them all
// under the row; the list re-renders on every new request
const openReqs = new Set<string>();

// "0.3 s", "12.4 s", "1m 12s"
const dur = (ms: number) =>
  ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : short(ms);

function renderRequests() {
  const tbody = $("requests").querySelector("tbody")!;
  $("requests-empty").hidden = reqs.length > 0;
  $("requests").hidden = reqs.length === 0;
  // rows that aged out or were wiped take their open state with them
  const keys = new Set(reqs.map(reqKey));
  for (const k of openReqs) if (!keys.has(k)) openReqs.delete(k);
  const num = (text: string, rate?: string) => {
    const td = el("td", "num", text);
    if (rate) td.append(el("span", "rate", ` · ${rate}`));
    return td;
  };
  const tps = (tokens: number, ms: number) =>
    tokens > 0 && ms > 0 ? `${whole((tokens / ms) * 1000)} tok/s` : "";
  const cell = (label: string, value: string) => {
    const div = el("div", "d");
    div.append(el("span", "k", label), el("span", "v", value));
    return div;
  };
  // every field, for the row a tap opened
  const details = (r: LastRequest) => {
    const tr = el("tr", "detail");
    const td = el("td");
    td.colSpan = 10;
    const grid = el("div", "dgrid");
    const cached = r.promptTokens - r.prefillTokens;
    const engineMs = r.prefillMs + r.decodeMs;
    grid.append(
      cell("Model", r.model ?? "unknown"),
      cell(
        "Started",
        r.startedAt != null ? fmtStamp.format(r.startedAt) : "not seen",
      ),
      cell(
        "Prompt",
        r.promptTokens > 0 ? `${count(r.promptTokens)} tok` : DASH,
      ),
      cell(
        "Cached",
        r.promptTokens > 0 && cached > 0
          ? `${count(cached)} tok · ${whole((cached / r.promptTokens) * 100)}%`
          : DASH,
      ),
      cell("Generated", `${count(r.generated)} tok`),
      cell(
        "Prefill",
        r.prefillMs
          ? [dur(r.prefillMs), tps(r.prefillTokens, r.prefillMs)]
              .filter(Boolean)
              .join(" · ")
          : DASH,
      ),
      cell(
        "Decode",
        r.decodeMs
          ? [dur(r.decodeMs), tps(r.generated, r.decodeMs)]
              .filter(Boolean)
              .join(" · ")
          : DASH,
      ),
      cell("TTFT", r.ttftMs != null ? dur(r.ttftMs) : DASH),
      cell(
        "Total",
        engineMs
          ? dur(engineMs)
          : r.startedAt != null
            ? dur(r.finishedAt - r.startedAt)
            : DASH,
      ),
      cell(
        "Outcome",
        r.cancelled
          ? r.count > 1
            ? `${r.count} requests cancelled by their clients in the same second`
            : "cancelled by the client"
          : r.count > 1
            ? `${r.count} requests completed in the same second`
            : "completed",
      ),
    );
    td.append(grid);
    tr.append(td);
    return tr;
  };
  tbody.replaceChildren(
    ...reqs.flatMap((r) => {
      const tr = el("tr", r.cancelled ? "cancelled" : "");
      // the chevron says the row opens; a cancel turns the time amber
      const when = el("td", "when");
      when.append(
        el("span", "chev"),
        el("span", "fin", fmtStamp.format(r.finishedAt)),
      );
      if (r.count > 1) when.append(el("span", "tag", `×${r.count}`));
      if (r.cancelled) when.title = "cancelled by the client";
      // the prompt is unknown for a cancel (its counters never moved)
      const cached = r.promptTokens - r.prefillTokens;
      const engineMs = r.prefillMs + r.decodeMs;
      const total =
        engineMs > 0
          ? engineMs
          : r.startedAt != null
            ? r.finishedAt - r.startedAt
            : 0;
      // the resident model at the finish, the favorite among several
      const model = el(
        "td",
        "model",
        r.model ? r.model.split("/").pop() : DASH,
      );
      if (r.model) model.title = r.model;
      tr.append(
        when,
        model,
        num(r.promptTokens > 0 ? count(r.promptTokens) : DASH),
        num(
          r.promptTokens > 0 && cached > 0
            ? `${whole((cached / r.promptTokens) * 100)}%`
            : DASH,
        ),
        num(count(r.generated)),
        num(
          r.prefillMs ? dur(r.prefillMs) : DASH,
          tps(r.prefillTokens, r.prefillMs),
        ),
        num(r.decodeMs ? dur(r.decodeMs) : DASH, tps(r.generated, r.decodeMs)),
        num(r.ttftMs != null ? dur(r.ttftMs) : DASH),
        num(total ? dur(total) : DASH),
      );
      const wide = tr.querySelectorAll("td.num");
      wide[3].classList.add("wide");
      wide[4].classList.add("wide");
      wide[5].classList.add("ttft");
      wide[1].classList.add("cached");
      wide[6].classList.add("total");
      const more = details(r);
      const key = reqKey(r);
      const open = openReqs.has(key);
      tr.classList.toggle("open", open);
      more.hidden = !open;
      tr.onclick = () => {
        const now = more.hidden === true;
        more.hidden = !now;
        tr.classList.toggle("open", now);
        if (now) openReqs.add(key);
        else openReqs.delete(key);
      };
      return [tr, more];
    }),
  );
}

function fetchRequests() {
  return fetch("/api/requests")
    .then((r) => r.json())
    .then((list: LastRequest[]) => {
      reqs = list;
      renderRequests();
    })
    .catch(() => {});
}

// A sample carrying a request the list does not have: merged in by key
// and kept in finish order, so a fetch racing a sample cannot duplicate or
// misplace a row.
function noteRequest(s: Sample) {
  const last = s.lastRequest;
  if (!last) return;
  const key = reqKey(last);
  if (reqs.some((r) => reqKey(r) === key)) return;
  reqs = [last, ...reqs]
    .sort((a, b) => b.finishedAt - a.finishedAt)
    .slice(0, REQUESTS_SHOWN);
  renderRequests();
}

// ---------- charts ----------

const SYNC_KEY = "mlx-spy";
const secs = (t: number[]) => t.map((v) => v / 1000);

type ChipDef = {
  label: string;
  color: string;
  fmt: (v: number | null) => string;
};

type Chart = {
  plot: uPlot;
  chips: HTMLElement[];
  defs: ChipDef[];
  // series arrays from a Series; `raw` holds per-chip display values when
  // the plotted values differ (stacked sums)
  build: (s: Series) => { data: uPlot.AlignedData; raw: (number | null)[][] };
  raw: (number | null)[][];
};

const charts: Chart[] = [];

const fmtClock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const fmtDay = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const fmtSecs = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
// the moment under the cursor: seconds on the 1h range, weekday once the
// range spans days
function cursorTime(u: uPlot, secsSinceEpoch: number): string {
  const span = (u.scales.x.max ?? 0) - (u.scales.x.min ?? 0);
  const f = span > 86_400 ? fmtDay : span <= 3_700 ? fmtSecs : fmtClock;
  return f.format(new Date(secsSinceEpoch * 1000));
}

// Sparklines carry no axes at all, like the console's: the head chips hold
// the numbers.
function axes(): uPlot.Axis[] {
  return [{ show: false }, { show: false }];
}

// Bars, one per sample, no gap: at 1h that is a bar per second, a solid
// block per request instead of a jagged line.
function line(color: string, extra: Partial<uPlot.Series> = {}): uPlot.Series {
  return {
    stroke: color,
    fill: `${color}b0`,
    width: 0,
    points: { show: false },
    spanGaps: false,
    paths: uPlot.paths.bars!({ size: [1, Number.POSITIVE_INFINITY], gap: 0 }),
    ...extra,
  };
}

function mkChart(
  id: string,
  defs: ChipDef[],
  opts: Partial<uPlot.Options>,
  build: Chart["build"],
) {
  const box = $(id);
  const plotEl = box.querySelector<HTMLElement>(".plot")!;
  const chipsEl = box.querySelector<HTMLElement>(".chips")!;
  const chips = defs.map((d) => {
    const chip = el("span", "chip");
    chip.style.setProperty("--c", d.color);
    chip.append(el("i"), el("span", "v none", DASH), el("small", "", d.label));
    chipsEl.append(chip);
    return chip.querySelector<HTMLElement>(".v")!;
  });
  const chart: Chart = {
    plot: null as unknown as uPlot,
    chips,
    defs,
    build,
    raw: [],
  };
  // time label that rides the cursor bar
  const stamp = el("div", "stamp");
  const plot = new uPlot(
    {
      width: plotEl.clientWidth,
      height: plotEl.clientHeight,
      cursor: {
        sync: { key: SYNC_KEY, setSeries: false },
        drag: { x: true, y: false },
        y: false,
      },
      legend: { show: false },
      scales: { x: { time: true } },
      axes: axes(),
      series: [{}],
      hooks: {
        ready: [(u) => u.over.append(stamp)],
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            showValues(chart, idx == null ? null : idx);
            const left = u.cursor.left ?? -1;
            if (idx == null || left < 0) {
              stamp.hidden = true;
              return;
            }
            stamp.hidden = false;
            stamp.textContent = cursorTime(u, u.data[0][idx]);
            // keep the label inside the plot near either edge
            const w = stamp.offsetWidth;
            const x = Math.min(
              Math.max(left - w / 2, 0),
              u.over.clientWidth - w,
            );
            stamp.style.left = `${x}px`;
          },
        ],
      },
      ...opts,
    },
    [[]],
    plotEl,
  );
  chart.plot = plot;
  charts.push(chart);
}

// idx null: the latest point, or, when nothing is running, the last non-zero
// value dimmed, so the chip is not a permanent 0 between requests.
function showValues(c: Chart, idx: number | null) {
  for (let i = 0; i < c.chips.length; i++) {
    const arr = c.raw[i] ?? [];
    let at = idx == null ? arr.length - 1 : idx;
    let idle = false;
    if (idx == null && at >= 0 && !((arr[at] ?? 0) > 0)) {
      idle = true;
      while (at >= 0 && !((arr[at] ?? 0) > 0)) at--;
    }
    const text = c.defs[i].fmt(at >= 0 ? (arr[at] ?? null) : null);
    c.chips[i].textContent = text;
    c.chips[i].classList.toggle("idle", idle);
    c.chips[i].classList.toggle("none", text === DASH);
  }
}

// whole tok/s; anything under one that is not zero reads as 1
const whole = (v: number | null | undefined) =>
  v == null ? DASH : v > 0 ? `${Math.max(1, Math.round(v))}` : "0";
const tps = whole;

function setupCharts() {
  const green = css("--green");
  const blue = css("--blue");
  const floor = (min: number) => (_u: uPlot, _min: number, max: number) =>
    [0, Math.max(min, max * 1.1)] as [number, number];

  mkChart(
    "c-decode",
    [{ label: "tok/s", color: green, fmt: tps }],
    {
      series: [{}, line(green)],
      scales: { x: { time: true }, y: { range: floor(10) } },
      axes: axes(),
    },
    (s) => ({ data: [secs(s.t), s.decodeTps], raw: [s.decodeTps] }),
  );
  mkChart(
    "c-prefill",
    [{ label: "tok/s", color: blue, fmt: tps }],
    {
      series: [{}, line(blue)],
      scales: { x: { time: true }, y: { range: floor(10) } },
      axes: axes(),
    },
    (s) => ({ data: [secs(s.t), s.prefillTps], raw: [s.prefillTps] }),
  );
  new ResizeObserver(() => {
    for (const c of charts) {
      const p = c.plot.root.parentElement!;
      if (p.clientWidth > 0 && p.clientWidth !== c.plot.width) {
        c.plot.setSize({ width: p.clientWidth, height: p.clientHeight });
      }
    }
  }).observe(document.body);
}

// ---------- data ----------

let range: Range = "1h";
let series: Series | null = null;
let refetchTimer: number | null = null;

function redraw() {
  if (!series) return;
  for (const c of charts) {
    const { data, raw } = c.build(series);
    c.raw = raw;
    c.plot.setData(data);
    if (c.plot.cursor.idx == null) showValues(c, null);
  }
}

function markRange(r: Range) {
  for (const b of $("ranges").querySelectorAll<HTMLElement>("[data-range]")) {
    b.classList.toggle("active", b.dataset.range === r);
  }
}

async function loadRange(r: Range) {
  const before = range;
  range = r;
  let body: { series: Series };
  try {
    const res = await fetch(`/api/history?range=${r}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = (await res.json()) as { series: Series };
  } catch (err) {
    // the old series stays, and so does its button
    if (range === r && series) {
      range = before;
      markRange(before);
    }
    console.warn(`history ${r}: ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (range !== r) return; // a later click won
  series = body.series;
  markRange(r);
  if (r === "1h") seedTiles(series);
  else if (lastSample) renderTiles(lastSample); // range totals changed
  redraw();
  if (refetchTimer) clearInterval(refetchTimer);
  refetchTimer =
    r === "1h" ? null : window.setInterval(() => void loadRange(range), 60_000);
}

// Live samples extend the raw 1h series in place; the oldest second drops
// off once the hour is full so the window slides.
function appendLive(s: Sample) {
  if (range !== "1h" || !series) return;
  const push = <K extends keyof Series>(k: K, v: Series[K][number]) =>
    (series![k] as unknown[]).push(v);
  push("t", s.t);
  push("engineUp", s.engineUp ? 1 : 0);
  push("epoch", s.epoch);
  push("decodeTps", s.decodeTps);
  push("prefillTps", s.prefillTps);
  push("requestsRunning", s.requestsRunning);
  push("requestsWaiting", s.requestsWaiting);
  push("cacheHitPct", s.cacheHitPct);
  push("cacheTokenPct", s.cacheTokenPct);
  push("gpuPct", s.gpuPct);
  push("procFootprint", s.mem.procFootprint);
  push("weights", s.mem.weights);
  push("hotCacheEst", s.mem.hotCacheEst);
  push("mlxActive", s.mem.mlxActive);
  push("mlxPool", s.mem.mlxPool);
  push("hostTotal", s.mem.hostTotal);
  push("hostFree", s.mem.hostFree);
  push("hostInactive", s.mem.hostInactive);
  push("hostWired", s.mem.hostWired);
  push("hostCompressed", s.mem.hostCompressed);
  push("procRss", s.mem.procRss);
  push(
    "diskBytes",
    s.disk.reduce((n, d) => n + d.bytes, 0),
  );
  push("ttftMs", s.ttftMs);
  push("ttftN", s.ttftN);
  push("generationTokens", s.generatedTokens);
  push("requestsTotal", s.requestsTotal);
  push("promptTokens", s.promptTokens);
  push("cachedPromptTokens", s.cachedPromptTokens);
  push("requestsCancelled", s.requestsCancelled);
  const cutoff = s.t - 3_600_000;
  while (series.t.length && series.t[0] < cutoff) {
    for (const k of Object.keys(series) as (keyof Series)[]) series[k].shift();
  }
  redraw();
}

// ---------- the store ----------

// The snapshot: on connect, and again from /api/snapshot after an action or
// a change in residency (the store fetches it). The render reads `busy`
// through the buttons; untracked keeps that from re-running this effect
// with a stale snapshot when an action ends.
effect(() => {
  const snap = snapshot.value;
  if (!snap) return;
  untracked(() => {
    engineName = ENGINE_NAME[snap.engine.id];
    $("engine-name").textContent = engineName;
    $("engine-url").textContent = snap.engine.url;
    renderHost(snap);
    renderModels(snap);
  });
});
effect(() => {
  if (event.value) showEvent(event.value);
});
// the monitor and requests pages show the socket's state in their head
effect(() => {
  const state = $("ws-state");
  const c = connection.value;
  state.textContent = c;
  state.className =
    c === "live" ? "pill live" : c === "reconnecting" ? "pill err" : "pill";
  if (c === "reconnecting") {
    $("engine-state").textContent = "unknown";
    $("engine-state").className = "pill";
    prevTok = null; // the next sample is not the successor of the last one
    chat?.onDisconnect();
  }
});

let connected = false;
listen((msg) => {
  if (msg.type === "snapshot") {
    if (msg.data.sample) renderTiles(msg.data.sample);
    // after a reconnect the series has a hole: fetch it again
    if (view === "requests") void fetchRequests();
    else if (view === "chat") {
      chat?.onSnapshot(msg.data.models, msg.data.chat, connected);
    } else if (connected) void loadRange(range);
    connected = true;
  } else if (msg.type === "event") {
    if (msg.data.action === "requestsClear" && msg.data.ok) {
      reqs = [];
      renderRequests();
    }
    if (msg.data.action === "historyClear" && msg.data.ok) {
      // every tab forgets what it learned from the wiped series
      lastDecode = lastPrefill = null;
      lastCacheHit = lastCacheTok = null;
      lastReq = prevTok = null;
      if (view === "requests") {
        reqs = [];
        renderRequests();
      } else {
        void loadRange(range);
      }
    }
  } else if (msg.type === "refresh") {
    chat?.onModels(msg.data.models);
  } else if (msg.type === "chat") {
    chat?.onChat(msg.data);
  } else if (view === "chat") {
    chat?.onSample(msg.data);
  } else {
    // the series first, so the tiles' range totals include this tick
    appendLive(msg.data);
    renderTiles(msg.data);
    if (view === "requests") noteRequest(msg.data);
  }
});

// ---------- boot ----------

for (const b of document.querySelectorAll<HTMLButtonElement>(
  ".shead [data-action]",
)) {
  b.onclick = () => void runAction(b.dataset.action as ActionName, null);
}

$("ranges").addEventListener("click", (ev) => {
  const btn = (ev.target as HTMLElement).closest("button");
  if (!btn?.dataset.range) return;
  void loadRange(btn.dataset.range as Range);
});

if (view === "requests") {
  // the live bar and the connection pill move over; the monitor's charts
  // are never built (redraw is a no-op without them)
  document.title = "mlx-spy · requests";
  $("view-monitor").hidden = true;
  $("view-requests").hidden = false;
  $("requests-head").append($("ws-state"));
  $("requests-live").append($("req"));
  // the action outcome line sits under the models table on the monitor;
  // here it goes under the list, for the clear button
  $("view-requests").append($("event"));
} else if (view === "chat") {
  // the frame fills the viewport; the header shows the connection pill
  $("view-monitor").hidden = true;
  $("view-chat").hidden = false;
  document.querySelector(".page")!.classList.add("chat");
  chat = mountChat();
} else {
  setupCharts();
  void loadRange("1h");
}
