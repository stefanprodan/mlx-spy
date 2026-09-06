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

function setBar(id: string, pct: number, warn = 75, crit = 90) {
  const el = $(id);
  el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  el.className = `fill${pct >= crit ? " crit" : pct >= warn ? " warn" : ""}`;
}

function renderTiles(s: Sample) {
  $("engine-dot").className = `dot ${s.engineUp ? "up" : "down"}`;
  $("t-decode").textContent = num(s.decodeTps, 1);
  $("t-decode-sub").textContent = s.engineUp
    ? `peak ${num(peakInView("decodeTps"))} tok/s in view`
    : "engine unreachable";
  $("t-prefill").textContent = num(s.prefillTps);
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
  $("t-cache-sub").textContent =
    lastCacheHit == null
      ? "no lookup yet"
      : `${num(lastCacheHit)}% hit rate · ${num(lastCacheTok)}% tokens reused`;
  const resident = s.models.filter((m) => m.loaded);
  $("t-resident").textContent = `${resident.length}`;
  $("t-resident-sub").textContent = resident.length
    ? resident
        .map((m) => `${m.id.split("/").pop()} ${gb(m.bytesResident)} GB`)
        .join(" · ")
    : s.engineUp
      ? "nothing loaded"
      : "";
  $("t-gpu").textContent = num(s.gpuPct);
  setBar("t-gpu-bar", s.gpuPct, 101, 101);
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
      );
      return tr;
    }),
  );
  const disk = snap.disk;
  const total = disk.reduce((n, d) => n + d.bytes, 0);
  $("disk-note").textContent = snap.engine.local
    ? `SSD cache tier ${gb(total)} GB in ${disk.length} dir${disk.length === 1 ? "" : "s"}`
    : "remote engine: pid, RSS and SSD tier not probed";
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
const pct = (v: number | null) => (v == null ? "-" : `${v.toFixed(0)}%`);
const gbv = (v: number | null) => (v == null ? "-" : `${gb(v)} GB`);
const int = (v: number | null) => (v == null ? "-" : `${Math.round(v)}`);

// nulls take the last value seen; leading nulls stay null
function carry(a: (number | null)[]): (number | null)[] {
  let last: number | null = null;
  return a.map((v) => {
    if (v != null) last = v;
    return last;
  });
}
// the un-carried cache series, so points draw only where a request ended
let cacheEvents: (number | null)[][] = [];
const eventPoints =
  (k: number): uPlot.Series.Points.Filter =>
  (_u, _sidx, show) =>
    show
      ? (cacheEvents[k]?.flatMap((v, i) => (v == null ? [] : [i])) ?? [])
      : null;

const yGb: uPlot.Axis["values"] = (_u, v) =>
  v.map((x) => `${(x / GB).toFixed(0)}G`);

function setupCharts() {
  const green = css("--green");
  const blue = css("--blue");
  const accent = css("--accent");
  const amber = css("--amber");
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
  mkChart(
    "c-cache",
    [
      { label: "hit", color: green, fmt: pct },
      { label: "reused", color: accent, fmt: pct },
    ],
    {
      // Values exist only where a request finished; between requests the
      // cache state is unchanged, so each value is carried forward as a step
      // and a dot marks the request itself.
      series: [
        {},
        line(green, {
          paths: uPlot.paths.stepped!({ align: 1 }),
          points: { show: true, size: 5, filter: eventPoints(0) },
        }),
        line(accent, {
          paths: uPlot.paths.stepped!({ align: 1 }),
          points: { show: true, size: 5, filter: eventPoints(1) },
        }),
      ],
      scales: { x: { time: true }, y: { range: [0, 105] } },
      axes: axes(),
    },
    (s) => {
      cacheEvents = [s.cacheHitPct, s.cacheTokenPct];
      return {
        data: [secs(s.t), carry(s.cacheHitPct), carry(s.cacheTokenPct)],
        raw: [carry(s.cacheHitPct), carry(s.cacheTokenPct)],
      };
    },
  );
  mkChart(
    "c-gpu",
    [{ label: "busy", color: accent, fmt: pct }],
    {
      series: [{}, line(accent, { fill: `${accent}22` })],
      scales: { x: { time: true }, y: { range: [0, 100] } },
      axes: axes(),
    },
    (s) => ({ data: [secs(s.t), s.gpuPct], raw: [s.gpuPct] }),
  );
  mkChart(
    "c-requests",
    [
      { label: "running", color: accent, fmt: int },
      { label: "waiting", color: amber, fmt: int },
    ],
    {
      series: [
        {},
        line(accent, {
          fill: `${accent}22`,
          paths: uPlot.paths.stepped!({ align: 1 }),
        }),
        line(amber, { paths: uPlot.paths.stepped!({ align: 1 }) }),
      ],
      scales: { x: { time: true }, y: { range: floor(2) } },
      axes: axes(),
    },
    (s) => ({
      data: [secs(s.t), s.requestsRunning, s.requestsWaiting],
      raw: [s.requestsRunning, s.requestsWaiting],
    }),
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
  fetch("/api/snapshot")
    .then((r) => r.json())
    .then((snap: Snapshot) => renderModels(snap))
    .catch(() => {});
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
