// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Dashboard client. One WebSocket delivers a snapshot on connect and a
// sample per second; the charts load a range from /api/history and, on the
// 1h range, grow with the live samples. Longer ranges re-fetch every minute
// (their points are bucket averages, so appending raw seconds would be
// wrong). Each chart box shows the latest values in its head and, while the
// cursor is over a plot, the values at the cursor; the cursor is shared
// across charts. Bundled by Bun from index.html; uPlot is the only
// dependency.

import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { ActionEvent, ActionName } from "../actions.ts";
import type { Capability } from "../engine/types.ts";
import type { Range, Series } from "../history.ts";
import type { Sample } from "../sample.ts";
import type { snapshot, WsMessage } from "../web.ts";

type Snapshot = ReturnType<typeof snapshot>;

const ENGINE_NAME: Record<Snapshot["engine"]["id"], string> = {
  mlxserve: "mlx-serve",
  omlx: "oMLX",
};

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- formatting ----------

// Binary GB everywhere memory is shown, the unit About This Mac uses for
// the machine (96 GB, not 103) and the engine's own --prefix-cache-* flags
// use for their budgets. Only the host disk is decimal, as Finder labels it.
const GB = 2 ** 30;
const gb = (b: number | null | undefined, d = 1) =>
  b == null ? "-" : (b / GB).toFixed(d);
const diskSize = (b: number) =>
  b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${Math.round(b / 1e9)} GB`;
const num = (n: number | null | undefined, d = 0) =>
  n == null ? "-" : n.toFixed(d);
const count = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1e3
      ? `${(n / 1e3).toFixed(1)}K`
      : `${n}`;

// ---------- tiles ----------

// Cache hit and TTFT are per finished request, so most windows carry null;
// the tile keeps the most recent value seen in this tab.
let lastTtft: number | null = null;
let lastCacheHit: number | null = null;
let lastCacheTok: number | null = null;
// the last request's prompt: how many tokens, how many came from the cache
let lastReq: { prompt: number; cached: number } | null = null;
let prevTok: { prompt: number; cached: number } | null = null;
// decode and prefill are 0 between requests; the tiles keep the last
// request's speeds
let lastDecode: number | null = null;
let lastPrefill: number | null = null;

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
  lastTtft ??= lastSet(s.ttftMs);
  lastCacheHit ??= lastSet(s.cacheHitPct);
  lastCacheTok ??= lastSet(s.cacheTokenPct);
  if (!lastReq) {
    // the last tick where the prompt counter advanced within one engine run
    for (let i = s.promptTokens.length - 1; i > 0; i--) {
      if (
        s.engineUp[i - 1] === 1 &&
        s.epoch[i] === s.epoch[i - 1] &&
        s.promptTokens[i - 1] > 0 &&
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
  $("t-decode").textContent = whole(lastDecode);
  $("t-decode-sub").textContent = !s.engineUp
    ? "engine unreachable"
    : lastDecode == null
      ? "no request in the last hour"
      : inView("decodeTps");
  if ((s.prefillTps ?? 0) > 0) lastPrefill = s.prefillTps;
  $("t-prefill").textContent = whole(lastPrefill);
  $("t-prefill-sub").textContent = !s.engineUp
    ? "engine unreachable"
    : lastPrefill == null
      ? "no request in the last hour"
      : inView("prefillTps");
  if (s.ttftMs != null) lastTtft = s.ttftMs;
  $("t-requests").textContent = `${s.requestsRunning}`;
  // a queue means every slot is busy: requests are waiting on each other
  $("t-requests-sub").replaceChildren(
    el(
      "span",
      s.requestsWaiting > 0 ? "warn" : "",
      `${s.requestsWaiting} waiting`,
    ),
    ` · TTFT ${lastTtft == null ? "-" : `${(lastTtft / 1000).toFixed(2)} s`}`,
  );
  if (s.cacheHitPct != null) lastCacheHit = s.cacheHitPct;
  if (s.cacheTokenPct != null) lastCacheTok = s.cacheTokenPct;
  if (s.engineUp && prevTok && s.promptTokens > prevTok.prompt) {
    lastReq = {
      prompt: s.promptTokens - prevTok.prompt,
      cached: s.cachedPromptTokens - prevTok.cached,
    };
  }
  prevTok = s.engineUp
    ? { prompt: s.promptTokens, cached: s.cachedPromptTokens }
    : null;
  $("t-cache").textContent = s.engineUp ? gb(s.mem.hotCacheEst) : "-";
  // the budget is per resident model, so the tile's ceiling scales with them
  const loaded = s.models.filter((m) => m.loaded).length;
  const hotMax = limits && limits.hotBytes > 0 ? limits.hotBytes * loaded : 0;
  setBar("t-cache-bar", hotMax ? (s.mem.hotCacheEst / hotMax) * 100 : 0);
  $("t-cache-track").hidden = !hotMax || !s.engineUp;
  $("t-cache-sub").textContent =
    lastCacheHit == null
      ? "no lookup in the last hour"
      : `${num(lastCacheHit)}% of lookups hit`;
  const ssd = s.disk.reduce((n, d) => n + d.bytes, 0);
  const dirs = s.disk.length;
  const ssdMax = limits && limits.diskBytes > 0 ? limits.diskBytes * dirs : 0;
  $("t-ssd").textContent = engineLocal ? gb(ssd) : "-";
  setBar("t-ssd-bar", ssdMax ? (ssd / ssdMax) * 100 : 0);
  $("t-ssd-track").hidden = !engineLocal || !ssdMax;
  $("t-ssd-sub").textContent = !engineLocal
    ? "not probed for a remote engine"
    : !dirs
      ? "tier is empty"
      : ssdMax
        ? `of ${gb(ssdMax, 0)} GB for ${dirs} model dir${dirs === 1 ? "" : "s"}`
        : `${dirs} model dir${dirs === 1 ? "" : "s"} on disk`;
  // prompt tokens served from the cache instead of being prefilled; the
  // number worth watching, GPU busy sits at 100% under MLX regardless
  $("t-eff").textContent = num(lastCacheTok);
  setBar("t-eff-bar", lastCacheTok ?? 0, 101, 101);
  $("t-eff-sub").textContent = lastReq
    ? `${count(lastReq.cached)} of ${count(lastReq.prompt)} prompt tokens`
    : "no request in the last hour";
  $("t-mem").textContent = gb(s.mem.procFootprint);
  const total = s.mem.hostTotal;
  const avail = s.mem.hostFree + s.mem.hostInactive;
  if (total > 0) {
    setBar("t-mem-bar", (s.mem.procFootprint / total) * 100);
    $("t-mem-sub").textContent = `${gb(avail, 0)} GB free of ${gb(total, 0)}`;
  } else {
    $("t-mem-sub").textContent = "engine footprint";
  }
  // tokens over the loaded range, not the engine's lifetime
  const gen = rangeTotal("generationTokens");
  const allTok = gen + rangeTotal("promptTokens");
  $("t-generated").textContent = count(gen);
  $("t-generated-sub").textContent =
    allTok > 0
      ? `${Math.round((gen / allTok) * 100)}% of ${count(allTok)} total`
      : "no request in view";
  renderServer(s);
  renderActivity(s);
}

// The live half of the Runtime section: the engine's residency and process.
function renderServer(s: Sample) {
  const loaded = s.models.filter((m) => m.loaded).length;
  const weights = $("engine-weights");
  weights.replaceChildren(
    s.engineUp ? `${gb(s.mem.weights)} GB` : "-",
    el(
      "small",
      "",
      !s.engineUp
        ? "unreachable"
        : loaded
          ? `${loaded} model${loaded === 1 ? "" : "s"} resident`
          : "nothing loaded",
    ),
  );
  // Memory and CPU come from the process table, so they need a local
  // engine; GPU busy is the engine's own gauge and works anywhere.
  const pid = s.enginePid;
  const why = !engineLocal
    ? "runs on another host"
    : s.engineUp
      ? "no mlx-serve process found"
      : "not running";
  $("engine-proc").textContent = pid == null ? "" : `pid ${pid}`;
  // the pill in the section head: uptime while online, else offline
  const es = $("engine-state");
  es.textContent = !s.engineUp
    ? "offline"
    : s.engineStartedAt == null
      ? "online"
      : `up ${duration(s.t - s.engineStartedAt)}`;
  es.className = s.engineUp ? "pill live" : "pill err";
  $("engine-mem").replaceChildren(
    pid == null ? "-" : `${gb(s.mem.procFootprint)} GB`,
    el("small", "", pid == null ? why : `RSS ${gb(s.mem.procRss)} GB`),
  );
  $("engine-cpu").replaceChildren(
    pid == null || s.engineCpuPct == null ? "-" : `${num(s.engineCpuPct)}%`,
    el("small", "", pid == null ? why : "of one core"),
  );
  $("engine-gpu").textContent = s.engineUp ? `${num(s.gpuPct)}%` : "-";
  if (s.mem.hostTotal > 0) {
    $("host-mem").replaceChildren(
      `${gb(s.mem.hostTotal, 0)} GB`,
      el("small", "", `${gb(s.mem.hostFree + s.mem.hostInactive, 0)} GB free`),
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
      $(id).textContent = "-";
    }
    return;
  }
  $("host-name").textContent = h.hostname;
  $("host-os").textContent = h.os;
  const cores =
    h.perfCores != null && h.effCores != null
      ? `${h.cpuCores} cores (${h.perfCores}P + ${h.effCores}E)`
      : `${h.cpuCores} cores`;
  $("host-chip").replaceChildren(h.chip ?? "unknown", el("small", "", cores));
  $("host-gpu").textContent =
    h.gpuCores != null ? `${h.gpuCores} cores` : "not detected";
  $("host-disk").replaceChildren(
    h.disk ? diskSize(h.disk.total) : "-",
    el("small", "", h.disk ? `${diskSize(h.disk.free)} free` : "not probed"),
  );
}

// How much a lifetime counter grew over the loaded range: the sum of its
// steps between consecutive points, within one engine run (a restart zeroes
// the counters) and only while the engine answered (a down sample holds 0).
// A step from 0 is skipped too: rows from before a column existed hold 0.
function rangeTotal(k: "generationTokens" | "promptTokens"): number {
  if (!series) return 0;
  const v = series[k];
  let sum = 0;
  for (let i = 1; i < v.length; i++) {
    if (
      series.engineUp[i] === 1 &&
      series.engineUp[i - 1] === 1 &&
      series.epoch[i] === series.epoch[i - 1] &&
      v[i - 1] > 0 &&
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
let busy: ActionName | null = null;

function setEnabled(btn: HTMLButtonElement, on: boolean, why: string) {
  btn.disabled = !on || busy !== null;
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
    b.disabled = busy !== null;
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
function renderActivity(s: Sample) {
  const pill = $("models-phase");
  const parts: string[] = [];
  let phase = "idle";
  let cls = "pill";
  if (!s.engineUp) {
    phase = "unreachable";
    cls = "pill err";
  } else if (s.requestsPrefilling > 0) {
    phase = "prefilling";
    cls = "pill prefill";
    if (s.prefillTokensLive > 0) {
      parts.push(`${count(s.prefillTokensLive)} tokens`);
    }
  } else if (s.requestsRunning > 0) {
    phase = "generating";
    cls = "pill live";
    parts.push(`${count(s.inflightTokens)} tokens`);
  }
  if (phase !== "idle" && s.engineUp && s.phaseSince != null) {
    parts.push(duration(s.t - s.phaseSince));
  }
  if (s.requestsRunning > 1) parts.push(`${s.requestsRunning} running`);
  pill.textContent = phase;
  pill.className = cls;
  const act = $("models-activity");
  act.replaceChildren(parts.join(" · "));
  if (s.requestsWaiting > 0) {
    act.append(
      parts.length ? " · " : "",
      el("span", "warn", `${s.requestsWaiting} waiting`),
    );
  }
}

const ACTION_LABEL: Record<ActionName, string> = {
  load: "load",
  unload: "unload",
  default: "set default",
  free: "restart engine",
  diskClear: "clear disk cache",
  historyClear: "clear history",
  favorite: "daily driver",
};

// The dialog copy states what happens, from the engine notes: an unload
// drops the model's RAM prefix cache, a restart drops everything but the
// SSD tier, loading past the residency cap evicts the least recently used.
function confirmText(action: ActionName, model: string | null): string {
  const loaded = loadedCount;
  const evict =
    loaded >= 2
      ? " Two models are resident, so the least recently used one is evicted."
      : "";
  const m = `<code>${model ?? ""}</code>`;
  switch (action) {
    case "load":
      return `Load ${m}? Reading the weights takes a few seconds; it becomes the default model.${evict}`;
    case "default":
      return `Make ${m} the default model? It is loaded if needed and chat requests without a model go to it.${evict}`;
    case "unload":
      return `Unload ${m}? Its weights and RAM prefix cache are freed; the SSD tier is kept. A model still resident becomes the default.`;
    case "free":
      return `Confirm ${engineName} restart`;
    case "diskClear":
      return `Restart the engine service and delete the SSD cache tier (${gb(diskTotal)} GB)? Every model is unloaded and every cached prefix is gone.`;
    case "historyClear":
      return "Delete the stored history? Every sample of the last 7 days is removed from mlx-spy's database and the graphs start over. The engine is not touched.";
    case "favorite":
      return ""; // a toggle, no dialog
  }
}

// `diskSize` shows the "also delete the SSD tier" checkbox, unchecked; the
// answer carries its state.
function confirm(
  html: string,
  okLabel: string,
  diskSize?: string,
): Promise<{ ok: boolean; checked: boolean }> {
  const dlg = $("confirm") as HTMLDialogElement;
  const check = $("confirm-check") as HTMLInputElement;
  $("confirm-text").innerHTML = html;
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
  busy = action;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".btn, .ibtn")) {
    if (b.closest("dialog")) continue;
    b.disabled = action !== null || b.title !== "";
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
  if (busy) return;
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
      showEvent({
        t: Date.now(),
        action,
        model,
        ok: false,
        ms: 0,
        detail: (body as { error: string }).error ?? `HTTP ${res.status}`,
      });
    }
    // a 200 carries the event; the /ws push shows it in every tab
  } catch (err) {
    showEvent({
      t: Date.now(),
      action,
      model,
      ok: false,
      ms: 0,
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    setBusy(null);
    void fetchSnapshot();
  }
}

function fetchSnapshot() {
  return fetch("/api/snapshot")
    .then((r) => r.json())
    .then((snap: Snapshot) => renderModels(snap))
    .catch(() => {});
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
    chip.append(el("i"), el("span", "v", "-"), el("small", "", d.label));
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
    c.chips[i].textContent = c.defs[i].fmt(at >= 0 ? (arr[at] ?? null) : null);
    c.chips[i].classList.toggle("idle", idle);
  }
}

// whole tok/s; anything under one that is not zero reads as 1
const whole = (v: number | null | undefined) =>
  v == null ? "-" : v > 0 ? `${Math.max(1, Math.round(v))}` : "0";
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

async function loadRange(r: Range) {
  range = r;
  const res = await fetch(`/api/history?range=${r}`);
  const body = (await res.json()) as { series: Series };
  if (range !== r) return; // a later click won
  series = body.series;
  if (r === "1h") seedTiles(series);
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
  push("generationTokens", s.generatedTokens);
  push("requestsTotal", s.requestsTotal);
  push("promptTokens", s.promptTokens);
  push("cachedPromptTokens", s.cachedPromptTokens);
  const cutoff = s.t - 3_600_000;
  while (series.t.length && series.t[0] < cutoff) {
    for (const k of Object.keys(series) as (keyof Series)[]) series[k].shift();
  }
  redraw();
}

// ---------- websocket ----------

// The model list rides on every sample; the table re-renders only when the
// residency picture changes, not 60 times a minute.
let modelsKey = "";
const modelsKeyOf = (models: Sample["models"]) =>
  models
    .map((m) => `${m.id}:${m.state}:${m.bytesResident}:${m.favorite ? 1 : 0}`)
    .join("|");

function refreshModels(s: Sample) {
  const key = modelsKeyOf(s.models);
  if (key === modelsKey) return;
  modelsKey = key;
  void fetchSnapshot();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  const state = $("ws-state");
  ws.onopen = () => {
    state.textContent = "live";
    state.className = "pill live";
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as WsMessage;
    if (msg.type === "snapshot") {
      engineName = ENGINE_NAME[msg.data.engine.id];
      $("engine-name").textContent = engineName;
      $("engine-url").textContent = msg.data.engine.url;
      renderHost(msg.data);
      $("version").textContent = `mlx-spy ${msg.data.version}`;
      renderModels(msg.data);
      modelsKey = modelsKeyOf(msg.data.models);
      if (msg.data.sample) renderTiles(msg.data.sample);
    } else if (msg.type === "event") {
      showEvent(msg.data);
      if (msg.data.action === "historyClear" && msg.data.ok) {
        // every tab forgets what it learned from the wiped series
        lastDecode = lastPrefill = lastTtft = null;
        lastCacheHit = lastCacheTok = null;
        lastReq = prevTok = null;
        void loadRange(range);
      }
      // another tab may have run it; the residency changed either way
      void fetchSnapshot();
    } else {
      renderTiles(msg.data);
      appendLive(msg.data);
      refreshModels(msg.data);
    }
  };
  ws.onclose = () => {
    state.textContent = "reconnecting";
    state.className = "pill err";
    $("engine-state").textContent = "unknown";
    $("engine-state").className = "pill";
    setTimeout(connect, 2000);
  };
}

// ---------- boot ----------

for (const b of document.querySelectorAll<HTMLButtonElement>(
  ".btns [data-action]",
)) {
  b.onclick = () => void runAction(b.dataset.action as ActionName, null);
}

$("ranges").addEventListener("click", (ev) => {
  const btn = (ev.target as HTMLElement).closest("button");
  if (!btn) return;
  for (const b of $("ranges").querySelectorAll("button")) {
    b.classList.toggle("active", b === btn);
  }
  void loadRange(btn.dataset.range as Range);
});

setupCharts();
void loadRange("1h");
connect();
