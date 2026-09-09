// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The copy of a download row in the models table (pure, tested in
// test/ui/pull.test.ts): which pulls the table shows, the dot, the bytes
// and speed, the state word.

import type { Pull } from "../../pulls.ts";
import { gb } from "../format.ts";

// A finished pull whose model the engine lists is that model's row now;
// every other pull stays until it is removed.
export function visiblePulls(pulls: Pull[], models: { id: string }[]): Pull[] {
  const listed = new Set(models.map((m) => m.id));
  return pulls.filter((p) => p.status !== "done" || !listed.has(p.repo));
}

export function pullDot(p: Pull): string {
  switch (p.status) {
    case "running":
      return "loading";
    case "failed":
      return "error";
    case "done":
      return "ready";
    default:
      return "";
  }
}

export function pullState(p: Pull): string {
  return p.status === "running" ? "downloading" : p.status;
}

// "3.2 / 16.7 GB · 48 MB/s · 5 min left" while running, the size when
// queued or done, what arrived when it stopped.
export function pullMeta(p: Pull): string {
  const total = `${gb(p.bytesTotal)} GB`;
  if (p.status === "queued" || p.status === "done") return total;
  const parts = [`${gb(p.bytesDone)} / ${total}`];
  if (p.status === "running" && p.speedBps != null && p.speedBps > 0) {
    parts.push(`${Math.round(p.speedBps / 1024 ** 2)} MB/s`);
    const left = (p.bytesTotal - p.bytesDone) / p.speedBps;
    parts.push(`${eta(left)} left`);
  }
  return parts.join(" · ");
}

export function eta(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes - hours * 60} min`;
}

// The share done, for the bar under the id.
export function pullPct(p: Pull): number {
  if (p.bytesTotal <= 0) return 0;
  return Math.min(100, (p.bytesDone / p.bytesTotal) * 100);
}
