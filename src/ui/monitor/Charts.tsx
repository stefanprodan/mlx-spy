// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One sparkline per chart, uPlot in a ref. The plot is created once, on
// mount, with the cursor stamp and a ResizeObserver, and destroyed on
// unmount; a second effect feeds it the series. The head chip shows the
// latest value, or the value under the cursor, which is shared across
// charts through uPlot's sync key.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { whole } from "./range.ts";
import { chipValue } from "./series.ts";

const SYNC_KEY = "mlx-spy";
const secs = (t: number[]) => t.map((v) => v / 1000);
const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

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

// Bars, one per sample, no gap: at 1h that is a bar per second, a solid
// block per request instead of a jagged line.
function line(color: string): uPlot.Series {
  return {
    stroke: color,
    fill: `${color}b0`,
    width: 0,
    points: { show: false },
    spanGaps: false,
    paths: uPlot.paths.bars!({ size: [1, Number.POSITIVE_INFINITY], gap: 0 }),
  };
}

const floor = (min: number) => (_u: uPlot, _min: number, max: number) =>
  [0, Math.max(min, max * 1.1)] as [number, number];

export type SparkProps = {
  label: string;
  color: string; // a CSS custom property, resolved on mount
  unit: string;
  t: number[];
  values: (number | null)[];
};

export function Spark({ label, color, unit, t, values }: SparkProps) {
  const plotEl = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  // the values the cursor hook reads; a ref so the hook sees the latest
  // without being rebuilt
  const raw = useRef(values);
  raw.current = values;
  const chip = useSignal(chipValue([], null, whole));
  const show = (idx: number | null) => {
    chip.value = chipValue(raw.current, idx, whole);
  };

  useEffect(() => {
    const el = plotEl.current!;
    const c = css(color);
    // time label that rides the cursor bar
    const stamp = document.createElement("div");
    stamp.className = "stamp";
    const u = new uPlot(
      {
        width: el.clientWidth,
        height: el.clientHeight,
        cursor: {
          sync: { key: SYNC_KEY, setSeries: false },
          drag: { x: true, y: false },
          y: false,
        },
        legend: { show: false },
        scales: { x: { time: true }, y: { range: floor(10) } },
        // sparklines carry no axes at all, like the console's: the head
        // chips hold the numbers
        axes: [{ show: false }, { show: false }],
        series: [{}, line(c)],
        hooks: {
          ready: [(u) => u.over.append(stamp)],
          setCursor: [
            (u) => {
              const idx = u.cursor.idx;
              show(idx == null ? null : idx);
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
      },
      [[]],
      el,
    );
    plot.current = u;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientWidth !== u.width) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight });
      }
    });
    ro.observe(document.body);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
    };
  }, [color]);

  useEffect(() => {
    const u = plot.current;
    if (!u) return;
    u.setData([secs(t), values]);
    if (u.cursor.idx == null) show(null);
  }, [t, values]);

  const v = chip.value;
  return (
    <div class="spark">
      <div class="shd">
        <span class="lbl">{label}</span>
        <span class="chips">
          <span class="chip" style={{ "--c": `var(${color})` }}>
            <i />
            <span class={`v${v.idle ? " idle" : ""}${v.none ? " none" : ""}`}>
              {v.text}
            </span>
            <small>{unit}</small>
          </span>
        </span>
      </div>
      <div class="plot" ref={plotEl} />
    </div>
  );
}

export function Charts({
  t,
  prefill,
  decode,
}: {
  t: number[];
  prefill: (number | null)[];
  decode: (number | null)[];
}) {
  return (
    <div class="sparks two">
      <Spark
        label="Prefill"
        color="--blue"
        unit="tok/s"
        t={t}
        values={prefill}
      />
      <Spark
        label="Decode"
        color="--green"
        unit="tok/s"
        t={t}
        values={decode}
      />
    </div>
  );
}
