// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Dashboard client. One WebSocket delivers a snapshot on connect and a
// sample per second; the graphs load a range from /api/history and, on the
// 1h range, grow with the live samples. Longer ranges re-fetch every minute
// (their points are bucket averages, so appending raw seconds would be
// wrong). Bundled by Bun from index.html; uPlot is the only dependency.

import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Range, Series } from "../history.ts";
import type { Sample } from "../sample.ts";
import type { snapshot, WsMessage } from "../web.ts";

type Snapshot = ReturnType<typeof snapshot>;

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const COLORS = {
  s1: css("--s1"),
  s2: css("--s2"),
  s3: css("--s3"),
  s4: css("--s4"),
  s5: css("--s5"),
  grid: css("--border"),
  text: css("--text-2"),
};

// ---------- formatting ----------

// decimal, as the engine notes and mlxctl report sizes
const GB = 1e9;
const fmtGB = (b: number | null | undefined) =>
  b == null ? "-" : `${(b / GB).toFixed(1)}`;
const fmtNum = (n: number | null | undefined, d = 0) =>
  n == null ? "-" : n.toFixed(d);
const fmtCount = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1e3
      ? `${(n / 1e3).toFixed(1)}k`
      : `${n}`;

// ---------- tiles ----------

// Cache hit and TTFT are per finished request, so most windows carry null;
// the tile shows the most recent value seen in this tab.
let lastCacheHit: number | null = null;
let lastTtft: number | null = null;

function renderTiles(s: Sample) {
  $("engine-dot").className = `dot ${s.engineUp ? "up" : "down"}`;
  $("t-decode").textContent = fmtNum(s.decodeTps);
  $("t-prefill").textContent = fmtNum(s.prefillTps);
  $("t-requests").textContent = `${s.requestsRunning}`;
  $("t-requests-sub").textContent =
    s.requestsWaiting > 0
      ? `+${s.requestsWaiting} waiting`
      : `${fmtCount(s.requestsTotal)} total`;
  if (s.ttftMs != null) lastTtft = s.ttftMs;
  $("t-ttft").textContent =
    lastTtft == null ? "-" : (lastTtft / 1000).toFixed(2);
  if (s.cacheHitPct != null) lastCacheHit = s.cacheHitPct;
  $("t-cache").textContent = fmtNum(lastCacheHit);
  $("t-gpu").textContent = fmtNum(s.gpuPct);
  $("t-mem").textContent = fmtGB(s.mem.procFootprint);
  const avail = s.mem.hostFree + s.mem.hostInactive;
  $("t-mem-sub").textContent =
    s.mem.hostTotal > 0
      ? `${fmtGB(avail)} GB free of ${fmtGB(s.mem.hostTotal)}`
      : "";
  $("t-generated").textContent = fmtCount(s.generatedTokens);
}

// ---------- models table ----------

function renderModels(snap: Snapshot) {
  const tbody = $("models").querySelector("tbody")!;
  tbody.replaceChildren(
    ...snap.models.map((m) => {
      const tr = document.createElement("tr");
      const cell = (text: string, cls = "") => {
        const td = document.createElement("td");
        td.className = cls;
        td.textContent = text;
        return td;
      };
      tr.append(
        cell(m.id, "id"),
        (() => {
          const td = document.createElement("td");
          const span = document.createElement("span");
          span.className = `state ${m.state}`;
          span.textContent = m.state;
          td.append(span);
          return td;
        })(),
        cell(m.loaded ? `${fmtGB(m.bytesResident)} GB` : "", "num"),
        cell(`${fmtGB(m.bytesOnDisk)} GB`, "num"),
        cell(m.contextLength == null ? "" : fmtCount(m.contextLength), "num"),
      );
      return tr;
    }),
  );
  const disk = snap.disk;
  const total = disk.reduce((n, d) => n + d.bytes, 0);
  $("disk-note").textContent = snap.engine.local
    ? `SSD cache tier: ${fmtGB(total)} GB in ${disk.length} dir${disk.length === 1 ? "" : "s"}`
    : "engine is remote: pid, RSS and SSD tier are not probed";
}

// ---------- charts ----------

const SYNC_KEY = "mlx-spy";

type Chart = {
  plot: uPlot;
  // series arrays from a Series; raw values kept for legend display where
  // the plotted values are stacked sums
  build: (s: Series) => uPlot.AlignedData;
};

const charts: Chart[] = [];

function axis(extra: Partial<uPlot.Axis> = {}): uPlot.Axis {
  return {
    stroke: COLORS.text,
    grid: { stroke: COLORS.grid, width: 1 },
    ticks: { stroke: COLORS.grid, width: 1 },
    font: "11px ui-monospace, Menlo, monospace",
    ...extra,
  };
}

function baseOpts(
  el: HTMLElement,
  extra: Partial<uPlot.Options>,
): uPlot.Options {
  return {
    width: el.clientWidth - 16,
    height: 180,
    cursor: {
      sync: { key: SYNC_KEY, setSeries: true },
      drag: { x: true, y: false },
    },
    legend: { live: true },
    scales: { x: { time: true } },
    axes: [axis(), axis({ size: 56 })],
    series: [{}],
    ...extra,
  };
}

const secs = (t: number[]) => t.map((v) => v / 1000);

function mkChart(
  id: string,
  extra: Partial<uPlot.Options>,
  build: Chart["build"],
) {
  const el = $(id);
  const plot = new uPlot(baseOpts(el, extra), [[]], el);
  charts.push({ plot, build });
}

function line(
  label: string,
  stroke: string,
  extra: Partial<uPlot.Series> = {},
): uPlot.Series {
  return { label, stroke, width: 2, spanGaps: false, ...extra };
}

function setupCharts() {
  mkChart(
    "c-tokens",
    {
      series: [{}, line("decode", COLORS.s1), line("prefill", COLORS.s2)],
      axes: [
        axis(),
        axis({ size: 56, values: (_u, v) => v.map((x) => `${x}`) }),
      ],
    },
    (s) => [secs(s.t), s.decodeTps, s.prefillTps],
  );
  mkChart(
    "c-cache",
    {
      series: [
        {},
        line("hit rate %", COLORS.s1, {
          spanGaps: true,
          points: { show: true, size: 6 },
        }),
        line("cached tokens %", COLORS.s3, {
          spanGaps: true,
          points: { show: true, size: 6 },
        }),
      ],
      scales: { x: { time: true }, y: { range: [0, 100] } },
    },
    (s) => [secs(s.t), s.cacheHitPct, s.cacheTokenPct],
  );
  // Stacked: weights at the bottom, hot cache estimate, then the rest of the
  // process. uPlot draws series in order, so the tallest sum comes first and
  // the legend shows the raw layer value, not the cumulative one.
  let raw: (number | null)[][] = [];
  const layerValue =
    (layer: number) =>
    (_u: uPlot, _v: number, _si: number, idx: number | null) =>
      idx == null ? "-" : fmtGB(raw[layer]?.[idx]);
  mkChart(
    "c-memory",
    {
      height: 220,
      series: [
        {},
        line("other process", COLORS.s3, {
          fill: `${COLORS.s3}55`,
          value: layerValue(2),
        }),
        line("hot cache est.", COLORS.s2, {
          fill: `${COLORS.s2}55`,
          value: layerValue(1),
        }),
        line("weights", COLORS.s1, {
          fill: `${COLORS.s1}55`,
          value: layerValue(0),
        }),
        line("host free+inactive", COLORS.s4, {
          dash: [6, 4],
          value: layerValue(3),
        }),
      ],
      // each fill is clipped to the layer below it instead of running to zero
      bands: [{ series: [1, 2] }, { series: [2, 3] }],
      axes: [
        axis(),
        axis({
          size: 56,
          values: (_u, v) => v.map((x) => `${(x / GB).toFixed(0)}G`),
        }),
      ],
      scales: {
        x: { time: true },
        y: { range: (_u, _min, max) => [0, max * 1.05] },
      },
    },
    (s) => {
      const weights = s.weights;
      const hot = s.hotCacheEst;
      const other = s.procFootprint.map((f, i) =>
        Math.max(0, f - weights[i] - hot[i]),
      );
      const avail = s.hostFree.map((f, i) => f + s.hostInactive[i]);
      raw = [weights, hot, other, avail];
      const top2 = weights.map((w, i) => w + hot[i]);
      const top3 = top2.map((w, i) => w + other[i]);
      return [secs(s.t), top3, top2, weights, avail];
    },
  );
  mkChart(
    "c-gpu",
    {
      series: [{}, line("gpu %", COLORS.s1, { fill: `${COLORS.s1}33` })],
      scales: { x: { time: true }, y: { range: [0, 100] } },
    },
    (s) => [secs(s.t), s.gpuPct],
  );
  mkChart(
    "c-requests",
    {
      series: [
        {},
        line("running", COLORS.s1, { fill: `${COLORS.s1}33` }),
        line("waiting", COLORS.s5),
      ],
      scales: {
        x: { time: true },
        y: { range: (_u, _min, max) => [0, Math.max(2, max)] },
      },
    },
    (s) => [secs(s.t), s.requestsRunning, s.requestsWaiting],
  );
  new ResizeObserver(() => {
    for (const c of charts) {
      const w = c.plot.root.parentElement!.clientWidth - 16;
      if (w > 0 && w !== c.plot.width)
        c.plot.setSize({ width: w, height: c.plot.height });
    }
  }).observe(document.body);
}

// ---------- data ----------

let range: Range = "1h";
let series: Series | null = null;
let refetchTimer: number | null = null;

function redraw() {
  if (!series) return;
  for (const c of charts) c.plot.setData(c.build(series));
}

async function loadRange(r: Range) {
  range = r;
  const res = await fetch(`/api/history?range=${r}`);
  const body = (await res.json()) as { series: Series };
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

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  const state = $("ws-state");
  ws.onopen = () => {
    state.textContent = "live";
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
      modelsFromSample(msg.data);
    }
  };
  ws.onclose = () => {
    state.textContent = "reconnecting";
    $("engine-dot").className = "dot";
    setTimeout(connect, 2000);
  };
}

// The model list rides on every sample; re-render the table only when the
// residency picture changes, not 60 times a minute.
let modelsKey = "";
const modelsKeyOf = (models: Sample["models"]) =>
  models.map((m) => `${m.id}:${m.state}:${m.bytesResident}`).join("|");
function modelsFromSample(s: Sample) {
  const key = modelsKeyOf(s.models);
  if (key === modelsKey) return;
  modelsKey = key;
  fetch("/api/snapshot")
    .then((r) => r.json())
    .then((snap: Snapshot) => renderModels(snap))
    .catch(() => {});
}

// ---------- boot ----------

$("ranges").addEventListener("click", (ev) => {
  const btn = (ev.target as HTMLElement).closest("button");
  if (!btn) return;
  for (const b of $("ranges").querySelectorAll("button"))
    b.classList.toggle("active", b === btn);
  void loadRange(btn.dataset.range as Range);
});

setupCharts();
void loadRange("1h");
connect();
