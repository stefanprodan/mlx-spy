// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The eight stat tiles: what each shows for a sample, and the memory a tab
// keeps between samples (values that are per request and null in between).
// Pure; tested in test/ui/tiles.test.ts.

import type { Series } from "../../history.ts";
import type { Sample } from "../../sample.ts";
import { count, DASH, gb, num } from "../format.ts";
import { inView, inViewMean, rangeTotal, whole } from "./range.ts";

// Cache hit and TTFT are per finished request, so most windows carry null;
// the tile keeps the most recent value seen in this tab. Decode and prefill
// are 0 between requests; the tiles keep the last request's speeds.
export type TileMemory = {
  lastCacheHit: number | null;
  lastCacheTok: number | null;
  // the last request's prompt: how many tokens, how many came from the cache
  lastReq: { prompt: number; cached: number } | null;
  prevTok: { epoch: number; prompt: number; cached: number } | null;
  lastDecode: number | null;
  lastPrefill: number | null;
};

export const initialTiles: TileMemory = {
  lastCacheHit: null,
  lastCacheTok: null,
  lastReq: null,
  prevTok: null,
  lastDecode: null,
  lastPrefill: null,
};

// A fresh tab has no "last request" memory, but the history does: take the
// most recent values from the raw 1h series so a reload does not blank the
// tiles. Only fills what is still empty; a live value always wins.
export function seed(m: TileMemory, s: Series): TileMemory {
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
  let lastReq = m.lastReq;
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
  return {
    lastDecode: m.lastDecode ?? lastNonZero(s.decodeTps),
    lastPrefill: m.lastPrefill ?? lastNonZero(s.prefillTps),
    lastCacheHit: m.lastCacheHit ?? lastSet(s.cacheHitPct),
    lastCacheTok: m.lastCacheTok ?? lastSet(s.cacheTokenPct),
    lastReq,
    prevTok: m.prevTok,
  };
}

// The live path: what a sample teaches the tab.
export function apply(m: TileMemory, s: Sample): TileMemory {
  let lastReq = m.lastReq;
  // consecutive samples of one engine run only: a reconnect gap or a new
  // epoch would merge every request in between into one
  if (
    s.engineUp &&
    m.prevTok &&
    m.prevTok.epoch === s.epoch &&
    s.promptTokens > m.prevTok.prompt
  ) {
    lastReq = {
      prompt: s.promptTokens - m.prevTok.prompt,
      cached: s.cachedPromptTokens - m.prevTok.cached,
    };
  }
  return {
    lastDecode: (s.decodeTps ?? 0) > 0 ? s.decodeTps : m.lastDecode,
    lastPrefill: (s.prefillTps ?? 0) > 0 ? s.prefillTps : m.lastPrefill,
    lastCacheHit: s.cacheHitPct ?? m.lastCacheHit,
    lastCacheTok: s.cacheTokenPct ?? m.lastCacheTok,
    lastReq,
    prevTok: s.engineUp
      ? {
          epoch: s.epoch,
          prompt: s.promptTokens,
          cached: s.cachedPromptTokens,
        }
      : null,
  };
}

// the next sample is not the successor of the last one (a reconnect)
export const disconnect = (m: TileMemory): TileMemory => ({
  ...m,
  prevTok: null,
});

export type Limits = { hotBytes: number; diskBytes: number } | null;

export type TileBar = {
  pct: number; // clamped to 0..100
  level: "" | "warn" | "crit";
  off: boolean;
};

export type Tile = {
  key: string;
  label: string;
  value: string;
  unit: string;
  none: boolean;
  bar?: TileBar;
  // the line under the value; a warn part is coloured
  sub: (string | { warn: string })[];
};

const bar = (pct: number, off = false, warn = 75, crit = 90): TileBar => ({
  pct: Math.max(0, Math.min(100, pct)),
  level: pct >= crit ? "crit" : pct >= warn ? "warn" : "",
  off,
});

const fmtStamp = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

// before the first sample: the same eight tiles, empty, so nothing jumps
export const PLACEHOLDER: Tile[] = [
  {
    key: "requests",
    label: "Requests",
    value: "0",
    unit: "served",
    none: false,
    sub: [],
  },
  {
    key: "generated",
    label: "Generated",
    value: "0",
    unit: "tok",
    none: false,
    sub: [],
  },
  {
    key: "prefill",
    label: "Prefill",
    value: DASH,
    unit: "tok/s",
    none: true,
    sub: [],
  },
  {
    key: "decode",
    label: "Decode",
    value: DASH,
    unit: "tok/s",
    none: true,
    sub: [],
  },
  {
    key: "eff",
    label: "Cache efficiency",
    value: DASH,
    unit: "% reused",
    none: true,
    bar: bar(0),
    sub: [],
  },
  {
    key: "mem",
    label: "Memory",
    value: DASH,
    unit: "GB",
    none: true,
    bar: bar(0),
    sub: [],
  },
  {
    key: "cache",
    label: "RAM cache",
    value: DASH,
    unit: "GB est.",
    none: true,
    bar: bar(0, true),
    sub: [],
  },
  {
    key: "ssd",
    label: "SSD cache",
    value: DASH,
    unit: "GB",
    none: true,
    bar: bar(0, true),
    sub: [],
  },
];

export function tiles(
  m: TileMemory,
  s: Sample,
  series: Series | null,
  limits: Limits,
  engineLocal: boolean,
): Tile[] {
  // idle: the last request's time is the one fact there is
  const lastAt = s.lastRequest
    ? `last at ${fmtStamp.format(s.lastRequest.finishedAt)}`
    : "";
  // requests over the loaded range, the counterpart of the Generated tile
  const served = rangeTotal(series, "requestsTotal");
  const cancelled = rangeTotal(series, "requestsCancelled");
  const ttft = inViewMean(series, "ttftMs");
  const requestsSub: Tile["sub"] = [];
  if (cancelled > 0) {
    requestsSub.push({ warn: `${count(cancelled)} cancelled` }, " · ");
  }
  if (served + cancelled > 0 && ttft != null) {
    requestsSub.push(`TTFT avg ${(ttft / 1000).toFixed(1)} s`);
  }
  // tokens over the loaded range, not the engine's lifetime
  const gen = rangeTotal(series, "generationTokens");
  const allTok = gen + rangeTotal(series, "promptTokens");
  const decode = whole(m.lastDecode);
  const prefill = whole(m.lastPrefill);
  // the budget is per resident model, so the tile's ceiling scales with
  // them; with nothing resident the bar sits at zero against one budget
  const loaded = s.models.filter((x) => x.loaded).length;
  const hotMax =
    limits && limits.hotBytes > 0 ? limits.hotBytes * Math.max(1, loaded) : 0;
  const cache = s.engineUp ? gb(s.mem.hotCacheEst, 0) : DASH;
  const ssd = s.disk.reduce((n, d) => n + d.bytes, 0);
  const dirs = s.disk.length;
  const ssdMax =
    limits && limits.diskBytes > 0 ? limits.diskBytes * Math.max(1, dirs) : 0;
  const ssdText = engineLocal ? gb(ssd, 0) : DASH;
  const eff = num(m.lastCacheTok);
  const mem = gb(s.mem.procFootprint, 0);
  const total = s.mem.hostTotal;
  const avail = s.mem.hostFree + s.mem.hostInactive;
  return [
    {
      key: "requests",
      label: "Requests",
      value: count(served),
      unit: "served",
      none: false,
      sub: requestsSub,
    },
    {
      key: "generated",
      label: "Generated",
      value: count(gen),
      unit: "tok",
      none: false,
      sub: [
        allTok > 0
          ? `${Math.round((gen / allTok) * 100)}% of ${count(allTok)} total`
          : "",
      ],
    },
    {
      key: "prefill",
      label: "Prefill",
      value: prefill,
      unit: "tok/s",
      none: prefill === DASH,
      sub: [m.lastPrefill == null ? lastAt : inView(series, "prefillTps")],
    },
    {
      key: "decode",
      label: "Decode",
      value: decode,
      unit: "tok/s",
      none: decode === DASH,
      sub: [m.lastDecode == null ? lastAt : inView(series, "decodeTps")],
    },
    {
      // prompt tokens served from the cache instead of being prefilled; the
      // number worth watching, GPU busy sits at 100% under MLX regardless
      key: "eff",
      label: "Cache efficiency",
      value: eff,
      unit: "% reused",
      none: eff === DASH,
      bar: bar(m.lastCacheTok ?? 0, false, 101, 101),
      sub: [
        m.lastReq
          ? `${count(m.lastReq.cached)} of ${count(m.lastReq.prompt)} prompt tokens`
          : "",
      ],
    },
    {
      key: "mem",
      label: "Memory",
      value: mem,
      unit: "GB",
      none: mem === DASH,
      bar: bar(total > 0 ? (s.mem.procFootprint / total) * 100 : 0),
      sub: [total > 0 ? `${gb(avail, 0)} GB free of ${gb(total, 0)}` : ""],
    },
    {
      key: "cache",
      label: "RAM cache",
      value: cache,
      unit: "GB est.",
      none: cache === DASH,
      bar: bar(
        hotMax ? (s.mem.hotCacheEst / hotMax) * 100 : 0,
        !hotMax || !s.engineUp,
      ),
      sub: [
        m.lastCacheHit != null
          ? `${num(m.lastCacheHit)}% of lookups hit`
          : hotMax
            ? loaded > 1
              ? `of ${gb(hotMax, 0)} GB for ${loaded} models`
              : `of ${gb(hotMax, 0)} GB per model`
            : "",
      ],
    },
    {
      key: "ssd",
      label: "SSD cache",
      value: ssdText,
      unit: "GB",
      none: ssdText === DASH,
      bar: bar(ssdMax ? (ssd / ssdMax) * 100 : 0, !engineLocal || !ssdMax),
      sub: [
        !engineLocal
          ? ""
          : ssdMax
            ? dirs > 1
              ? `of ${gb(ssdMax, 0)} GB for ${dirs} model dirs`
              : `of ${gb(ssdMax, 0)} GB per model`
            : dirs
              ? `${dirs} model dir${dirs === 1 ? "" : "s"} on disk`
              : "",
      ],
    },
  ];
}
