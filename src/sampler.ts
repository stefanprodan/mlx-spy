// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The 1 Hz loop. Each tick reads the engine's metrics, compares them with the
// previous reading (rates, epoch), refreshes the model list every few ticks,
// and hands the Sample to the history and to listeners. tick() is public and
// the clock injectable so tests drive it without timers or a network.

import type { Engine, ModelInfo } from "./engine/types.ts";
import type { History } from "./history.ts";
import {
  buildSample,
  computeRates,
  downSample,
  type Reading,
  readEngine,
  type Sample,
} from "./sample.ts";

export const TICK_MS = 1000;
// The model list changes only on load/unload/eviction; 5 s is quick enough
// for the table and keeps the per-tick work to one request.
const MODELS_EVERY_TICKS = 5;

export type SamplerOptions = {
  now?: () => number;
  log?: (line: string) => void;
};

export class Sampler {
  private prev: Reading | null = null;
  private epoch: number;
  private models: ModelInfo[] = [];
  private ticksSinceModels = MODELS_EVERY_TICKS; // fetch on the first tick
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private readonly listeners = new Set<(s: Sample) => void>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(
    private readonly engine: Engine,
    private readonly history: History,
    opts: SamplerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    // Carry the epoch and the last counters across our own restarts, so the
    // first reading after a restart still detects an engine restart that
    // happened while we were down.
    const state = history.loadSamplerState();
    this.epoch = state.epoch;
    if (state.counters) {
      this.prev = {
        t: 0,
        metrics: {
          counters: state.counters,
          gauges: {
            requestsRunning: 0,
            requestsWaiting: 0,
            requestsPrefilling: 0,
            gpuPct: 0,
            memoryBytes: 0,
            generationTokensLive: 0,
            prefillTokensLive: 0,
            mlxActiveBytes: 0,
            mlxCacheBytes: 0,
          },
          histograms: {
            ttftSeconds: { count: 0, sum: 0 },
            e2eLatencySeconds: { count: 0, sum: 0 },
            prefillTimeSeconds: { count: 0, sum: 0 },
            decodeTimeSeconds: { count: 0, sum: 0 },
            promptTokens: { count: 0, sum: 0 },
            outputTokens: { count: 0, sum: 0 },
          },
        },
      };
    }
  }

  onSample(fn: (s: Sample) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  currentEpoch(): number {
    return this.epoch;
  }

  currentModels(): ModelInfo[] {
    return this.models;
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // One sample. A slow engine must not pile up ticks: if the previous one is
  // still running this one is skipped, and the next tick's window is simply
  // wider (rates divide by the measured window, not by TICK_MS).
  async tick(): Promise<Sample | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      const reading = await readEngine(this.engine);
      const t = this.now();
      let sample: Sample;
      if (!reading) {
        sample = downSample(t, this.epoch);
        // a dead engine breaks the window: the next reading starts fresh
        // rather than computing rates over the outage
        this.prev = null;
        this.models = [];
      } else {
        reading.t = t;
        // The restored previous reading (t=0 after a restart) only serves
        // the epoch check; its gauges are zero and its window meaningless.
        const restored = this.prev !== null && this.prev.t === 0;
        const rates = computeRates(this.prev, reading, this.epoch);
        if (rates.epoch !== this.epoch) {
          this.log(
            `engine counters reset: epoch ${this.epoch} -> ${rates.epoch}`,
          );
          this.epoch = rates.epoch;
        }
        if (restored) {
          rates.windowMs = null;
          rates.decodeTps = null;
          rates.prefillTps = null;
          rates.cacheHitPct = null;
          rates.cacheTokenPct = null;
        }
        if (++this.ticksSinceModels >= MODELS_EVERY_TICKS) {
          this.ticksSinceModels = 0;
          try {
            this.models = await this.engine.models();
          } catch {
            // keep the last list; the next tick retries
          }
        }
        sample = buildSample(reading, rates, this.models);
        this.prev = reading;
        this.history.saveSamplerState({
          epoch: this.epoch,
          counters: reading.metrics.counters,
        });
      }
      this.history.push(sample);
      for (const fn of this.listeners) fn(sample);
      return sample;
    } finally {
      this.inFlight = false;
    }
  }
}
