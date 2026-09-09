// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Number and time formatting shared by the pages. Pure; tested in
// test/ui/format.test.ts.

// Binary GB everywhere memory is shown, the unit About This Mac uses for
// the machine (96 GB, not 103) and the engine's own --prefix-cache-* flags
// use for their budgets. Only the host disk is decimal, as Finder labels it.
export const GB = 2 ** 30;
// A value with no fact behind it is one quiet dash, everywhere; the CSS
// dims it through the "none" class. Counts stay 0: that is a fact.
export const DASH = "–";
export const gb = (b: number | null | undefined, d = 1) =>
  b == null ? DASH : (b / GB).toFixed(d);
export const diskSize = (b: number) =>
  b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${Math.round(b / 1e9)} GB`;
export const num = (n: number | null | undefined, d = 0) =>
  n == null ? DASH : n.toFixed(d);
export const count = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1e3
      ? `${(n / 1e3).toFixed(1)}K`
      : `${n}`;

// the chat's stats: "1 min 5 s", "4.2 s", "12 s"
export const secs = (ms: number) =>
  ms >= 60_000
    ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
    : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
export const tps = (tokens: number, ms: number) =>
  ms > 0
    ? `${Math.round(tokens / (ms / 1000)).toLocaleString("en-US")} tok/s`
    : "-";

const fmtClock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const fmtDate = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});
const DAY = 86_400_000;
const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);

// "now", the clock today, the weekday this week, else the date
export function when(t: number, now: number): string {
  if (now - t < 60_000) return "now";
  const today = startOfDay(now);
  if (t >= today) return fmtClock.format(t);
  if (t >= today - 6 * DAY) return fmtDay.format(t);
  return fmtDate.format(t);
}

// the chat list's sections
export function group(t: number, now: number): string {
  const today = startOfDay(now);
  if (t >= today) return "Today";
  if (t >= today - DAY) return "Yesterday";
  if (t >= today - 6 * DAY) return "This week";
  return "Earlier";
}

// an uptime: "3d 4h", "2h 15m", "40s"
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}
