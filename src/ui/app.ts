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

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- formatting ----------

// decimal, as the engine notes and mlxctl report sizes
const GB = 1e9;
const gb = (b: number | null | undefined, d = 1) =>
  b == null ? "-" : (b / GB).toFixed(d);
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
// decode and prefill are 0 between requests; the tiles keep the last
// request's speeds
let lastDecode: number | null = null;
let lastPrefill: number | null = null;

function setBar(id: string, pct: number, warn = 75, crit = 90) {
  const el = $(id);
  el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  el.className = `fill${pct >= crit ? " crit" : pct >= warn ? " warn" : ""}`;
}

function renderTiles(s: Sample) {
  $("engine-dot").className = `dot ${s.engineUp ? "up" : "down"}`;
  const decoding = (s.decodeTps ?? 0) > 0;
  if (decoding) lastDecode = s.decodeTps;
  $("t-decode").textContent = num(lastDecode, 1);
  $("t-decode-sub").textContent = !s.engineUp
    ? "engine unreachable"
    : lastDecode == null
      ? "no request yet"
      : `${decoding ? "" : "last request · "}peak ${num(peakInView("decodeTps"))} tok/s in view`;
  if ((s.prefillTps ?? 0) > 0) lastPrefill = s.prefillTps;
  $("t-prefill").textContent = num(lastPrefill);
  if (s.ttftMs != null) lastTtft = s.ttftMs;
  $("t-prefill-sub").textContent =
    lastTtft == null
      ? "no request yet"
      : `TTFT ${(lastTtft / 1000).toFixed(2)} s on the last request`;
  $("t-requests").textContent = `${s.requestsRunning}`;
  $("t-requests-sub").textContent =
    `${s.requestsWaiting} waiting · ${count(s.requestsTotal)} served`;
  if (s.cacheHitPct != null) lastCacheHit = s.cacheHitPct;
  if (s.cacheTokenPct != null) lastCacheTok = s.cacheTokenPct;
  $("t-cache").textContent = s.engineUp ? gb(s.mem.hotCacheEst) : "-";
  // the budget is per resident model, so the tile's ceiling scales with them
  const loaded = s.models.filter((m) => m.loaded).length;
  const hotMax = limits && limits.hotBytes > 0 ? limits.hotBytes * loaded : 0;
  setBar("t-cache-bar", hotMax ? (s.mem.hotCacheEst / hotMax) * 100 : 0);
  $("t-cache-track").hidden = !hotMax || !s.engineUp;
  $("t-cache-sub").textContent =
    lastCacheHit == null
      ? "no lookup yet"
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
  $("t-eff-sub").textContent =
    lastCacheTok == null
      ? "no request yet"
      : "of prompt tokens on the last request";
  $("t-mem").textContent = gb(s.mem.procFootprint);
  const total = s.mem.hostTotal;
  const avail = s.mem.hostFree + s.mem.hostInactive;
  if (total > 0) {
    setBar("t-mem-bar", (s.mem.procFootprint / total) * 100);
    $("t-mem-sub").textContent = `${gb(avail, 0)} GB free of ${gb(total, 0)}`;
  } else {
    $("t-mem-sub").textContent = "engine footprint";
  }
  $("t-generated").textContent = count(s.generatedTokens);
  $("t-generated-sub").textContent =
    `${count(s.requestsTotal)} request${s.requestsTotal === 1 ? "" : "s"} this run`;
}

// highest value of a series in the loaded range, for the decode tile
function peakInView(k: "decodeTps" | "prefillTps"): number {
  let peak = 0;
  for (const v of series?.[k] ?? []) if (v != null && v > peak) peak = v;
  return peak;
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

function renderModels(snap: Snapshot) {
  const tbody = $("models").querySelector("tbody")!;
  tbody.replaceChildren(
    ...snap.models.map((m) => {
      const tr = el("tr", m.loaded ? "ready" : "");
      const caps = el("td", "caps");
      for (const c of m.capabilities) caps.append(el("span", "cap", c));
      tr.append(
        el("td", "id", m.id),
        caps,
        el(
          "td",
          "num",
          m.loaded
            ? `${gb(m.bytesResident)} GB`
            : `${gb(m.bytesOnDisk)} GB on disk`,
        ),
        el(
          "td",
          "num",
          m.contextLength == null ? "" : `${count(m.contextLength)} ctx`,
        ),
        el("td", `state ${m.state}`, m.state),
        modelButtons(m, snap),
      );
      return tr;
    }),
  );
  const disk = snap.disk;
  const total = disk.reduce((n, d) => n + d.bytes, 0);
  $("disk-note").textContent = snap.engine.local
    ? `SSD cache tier ${gb(total)} GB in ${disk.length} dir${disk.length === 1 ? "" : "s"}`
    : "remote engine: pid, RSS and SSD tier not probed";
  diskTotal = total;
  engineLocal = snap.engine.local;
  limits = snap.engine.limits;
  loadedCount = snap.models.filter((m) => m.loaded).length;
  const can = (c: Capability) => snap.engine.capabilities.includes(c);
  setEnabled(
    $("a-free") as HTMLButtonElement,
    can("restart") && snap.engine.local,
    "restarts the engine service; only for a local engine",
  );
  setEnabled(
    $("a-disk") as HTMLButtonElement,
    can("diskClear") && snap.engine.local,
    "deletes the SSD cache tier; only for a local engine",
  );
  if (snap.events.length) showEvent(snap.events[snap.events.length - 1]);
  if (snap.running) setBusy(snap.running);
}

// ---------- actions ----------

let diskTotal = 0;
let engineLocal = false;
let limits: Snapshot["engine"]["limits"] = null;
let loadedCount = 0;
let busy: ActionName | null = null;

function setEnabled(btn: HTMLButtonElement, on: boolean, why: string) {
  btn.disabled = !on || busy !== null;
  btn.title = on ? "" : why;
}

function modelButtons(m: Snapshot["models"][number], snap: Snapshot) {
  const td = el("td", "act");
  const can = (c: Capability) => snap.engine.capabilities.includes(c);
  const btn = (label: string, action: ActionName, cls = "") => {
    const b = el("button", `btn ${cls}`.trim(), label);
    b.type = "button";
    b.disabled = busy !== null;
    b.onclick = () => void runAction(action, m.id);
    return b;
  };
  if (m.loaded) {
    if (can("default")) td.append(btn("Set default", "default"));
    if (can("unload")) td.append(btn("Unload", "unload", "danger"));
  } else if (can("load")) {
    td.append(btn("Load", "load"));
    if (can("default")) td.append(btn("Load as default", "default"));
  }
  return td;
}

const ACTION_LABEL: Record<ActionName, string> = {
  load: "load",
  unload: "unload",
  default: "set default",
  free: "free RAM",
  diskClear: "clear disk cache",
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
      return `Load ${m}? Reading the weights takes a few seconds.${evict}`;
    case "default":
      return `Make ${m} the default model? It is loaded if needed and chat requests without a model go to it.${evict}`;
    case "unload":
      return `Unload ${m}? Its weights and RAM prefix cache are freed; the SSD tier is kept.`;
    case "free":
      return "Restart the engine service? Every model is unloaded and the RAM cache is gone. The SSD tier is kept and comes back on the next load.";
    case "diskClear":
      return `Restart the engine service and delete the SSD cache tier (${gb(diskTotal)} GB)? Every model is unloaded and every cached prefix is gone.`;
  }
}

function confirm(html: string, okLabel: string): Promise<boolean> {
  const dlg = $("confirm") as HTMLDialogElement;
  $("confirm-text").innerHTML = html;
  $("confirm-ok").textContent = okLabel;
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === "ok");
    dlg.returnValue = "";
    dlg.showModal();
  });
}

function setBusy(action: ActionName | null) {
  busy = action;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".btn")) {
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
  if (
    !(await confirm(
      confirmText(action, model),
      label[0].toUpperCase() + label.slice(1),
    ))
  ) {
    return;
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

const AXIS_FONT = "11px ui-monospace, Menlo, monospace";

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
// the numbers. The tall memory chart keeps three y labels and no grid.
function axes(yValues?: uPlot.Axis["values"]): uPlot.Axis[] {
  const x: uPlot.Axis = { show: false };
  if (!yValues) return [x, { show: false }];
  return [
    x,
    {
      stroke: css("--faint-2"),
      font: AXIS_FONT,
      grid: { show: false },
      ticks: { show: false },
      gap: 8,
      size: 40,
      splits: (_u, _ax, min, max) => [min, (min + max) / 2, max],
      values: yValues,
    },
  ];
}

function line(color: string, extra: Partial<uPlot.Series> = {}): uPlot.Series {
  return {
    stroke: color,
    width: 1.5,
    points: { show: false },
    spanGaps: false,
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

// idx null: the latest point
function showValues(c: Chart, idx: number | null) {
  for (let i = 0; i < c.chips.length; i++) {
    const arr = c.raw[i] ?? [];
    const at = idx == null ? arr.length - 1 : idx;
    c.chips[i].textContent = c.defs[i].fmt(at >= 0 ? (arr[at] ?? null) : null);
  }
}

const tps = (v: number | null) => (v == null ? "-" : v.toFixed(v < 10 ? 1 : 0));
const gbv = (v: number | null) => (v == null ? "-" : `${gb(v)} GB`);

const yGb: uPlot.Axis["values"] = (_u, v) =>
  v.map((x) => `${(x / GB).toFixed(0)}G`);

function setupCharts() {
  const green = css("--green");
  const blue = css("--blue");
  const [m1, m2, m3, m4] = ["--m1", "--m2", "--m3", "--m4"].map(css);
  const floor = (min: number) => (_u: uPlot, _min: number, max: number) =>
    [0, Math.max(min, max * 1.1)] as [number, number];

  mkChart(
    "c-decode",
    [{ label: "tok/s", color: green, fmt: tps }],
    {
      series: [{}, line(green, { fill: `${green}22` })],
      scales: { x: { time: true }, y: { range: floor(10) } },
      axes: axes(),
    },
    (s) => ({ data: [secs(s.t), s.decodeTps], raw: [s.decodeTps] }),
  );
  mkChart(
    "c-prefill",
    [{ label: "tok/s", color: blue, fmt: tps }],
    {
      series: [{}, line(blue, { fill: `${blue}22` })],
      scales: { x: { time: true }, y: { range: floor(10) } },
      axes: axes(),
    },
    (s) => ({ data: [secs(s.t), s.prefillTps], raw: [s.prefillTps] }),
  );
  // Stacked: weights at the bottom, the hot cache estimate, then the rest
  // of the process; the host's free plus inactive memory as a dashed line.
  // uPlot draws series in order, so the tallest sum comes first; bands clip
  // each fill to the layer below it.
  mkChart(
    "c-memory",
    [
      { label: "weights", color: m1, fmt: gbv },
      { label: "hot cache est.", color: m2, fmt: gbv },
      { label: "other", color: m3, fmt: gbv },
      // read from the data at the cursor, not plotted: on the same axis it
      // would flatten the stack to a fifth of the plot
      { label: "host free", color: m4, fmt: gbv },
    ],
    {
      series: [
        {},
        line(m3, { fill: `${m3}44` }),
        line(m2, { fill: `${m2}44` }),
        line(m1, { fill: `${m1}44` }),
      ],
      bands: [{ series: [1, 2] }, { series: [2, 3] }],
      scales: { x: { time: true }, y: { range: floor(GB) } },
      axes: axes(yGb),
    },
    (s) => {
      const weights = s.weights;
      const hot = s.hotCacheEst;
      const other = s.procFootprint.map((f, i) =>
        Math.max(0, f - weights[i] - hot[i]),
      );
      const avail = s.hostFree.map((f, i) => f + s.hostInactive[i]);
      const top2 = weights.map((w, i) => w + hot[i]);
      const top3 = top2.map((w, i) => w + other[i]);
      return {
        data: [secs(s.t), top3, top2, weights],
        raw: [weights, hot, other, avail],
      };
    },
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
  models.map((m) => `${m.id}:${m.state}:${m.bytesResident}`).join("|");

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
      $("engine-url").textContent = msg.data.engine.url;
      $("version").textContent = `mlx-spy ${msg.data.version}`;
      renderModels(msg.data);
      modelsKey = modelsKeyOf(msg.data.models);
      if (msg.data.sample) renderTiles(msg.data.sample);
    } else if (msg.type === "event") {
      showEvent(msg.data);
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
    $("engine-dot").className = "dot";
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
