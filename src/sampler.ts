// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The 1 Hz loop. Each tick reads the engine's metrics, compares them with the
// previous reading (rates, epoch), probes host memory and the engine process,
// refreshes the model list every few ticks and the disk tier every 30, and
// hands the Sample to the history and to listeners. tick() is public and the
// clock injectable so tests drive it without timers or a network.

import type { Engine, ModelInfo } from "./engine/types.ts";
import type { History } from "./history.ts";
import { cacheDirSizes } from "./host/disk.ts";
import { NULL_PROBES } from "./host/index.ts";
import type { DiskDir, HostProbes, HostSnapshot } from "./host/types.ts";
import {
  buildSample,
  computeRates,
  downSample,
  EMPTY_LIVE,
  type LiveState,
  type Reading,
  readEngine,
  type Sample,
} from "./sample.ts";

export const TICK_MS = 1000;
// The model list changes only on load/unload/eviction; 5 s is quick enough
// for the table and keeps the per-tick work to one request.
const MODELS_EVERY_TICKS = 5;
// A pid scan walks the whole process table; only when the pid is unknown,
// and not on every tick when the engine is simply not running.
const PID_EVERY_TICKS = 5;
// The tier changes by hundreds of MB per request; a stat walk of a 50 GB
// tier is cheap but not free, and the number is for a tile, not a graph.
const DISK_EVERY_TICKS = 30;

export type SamplerOptions = {
  now?: () => number;
  log?: (line: string) => void;
  probes?: HostProbes;
  // engine runs on this host: probe its pid and size its cache dirs
  local?: boolean;
};

export class Sampler {
  private prev: Reading | null = null;
  // where the live token gauges last moved, for the rates between moves
  private live: LiveState = EMPTY_LIVE;
  private epoch: number;
  private models: ModelInfo[] = [];
  private ticksSinceModels = MODELS_EVERY_TICKS; // fetch on the first tick
  private pid: number | null = null;
  private ticksSincePid = PID_EVERY_TICKS;
  private prevCpu: { pid: number | null; t: number; cpuNs: number } | null =
    null;
  private disk: DiskDir[] = [];
  private ticksSinceDisk = DISK_EVERY_TICKS;
  private diskScan: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private readonly listeners = new Set<(s: Sample) => void>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly probes: HostProbes;
  private readonly local: boolean;

  constructor(
    private readonly engine: Engine,
    private readonly history: History,
    opts: SamplerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.probes = opts.probes ?? NULL_PROBES;
    this.local = opts.local ?? false;
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

  currentDisk(): DiskDir[] {
    return this.disk;
  }

  // After an action the residency picture changed; do not wait for the
  // periodic fetch. Failures keep the last list, as in tick().
  async refreshModels(): Promise<ModelInfo[]> {
    try {
      this.models = await this.engine.models();
      this.ticksSinceModels = 0;
    } catch {
      // the next tick retries
    }
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

  // Host side of a tick. The pid is validated by name each scan interval so
  // a restarted engine (new pid) is picked up and a recycled pid is not
  // trusted. The disk walk is async and its result lands on a later tick.
  private probeHost(): HostSnapshot {
    if (this.local) {
      if (++this.ticksSincePid >= PID_EVERY_TICKS) {
        this.ticksSincePid = 0;
        const names = this.engine.processNames();
        if (this.pid === null || !this.probes.pidMatches(this.pid, names)) {
          const found = this.probes.findPid(names);
          if (found !== this.pid) {
            this.log(`engine pid ${this.pid ?? "none"} -> ${found ?? "none"}`);
          }
          this.pid = found;
        }
      }
      if (++this.ticksSinceDisk >= DISK_EVERY_TICKS && !this.diskScan) {
        this.ticksSinceDisk = 0;
        this.diskScan = cacheDirSizes(this.engine.cacheDirs())
          .then((d) => {
            this.disk = d;
          })
          .catch(() => {})
          .finally(() => {
            this.diskScan = null;
          });
      }
    }
    let proc = this.pid === null ? null : this.probes.processMemory(this.pid);
    if (this.pid !== null && proc === null) {
      // the process is gone; rescan on the next interval
      this.pid = null;
      this.ticksSincePid = PID_EVERY_TICKS;
      proc = null;
    }
    // CPU time is cumulative; the rate over the tick is what the row shows.
    // A new pid restarts the window (a fresh process starts near zero).
    let cpuPct: number | null = null;
    const now = this.now();
    if (proc && this.prevCpu && this.prevCpu.pid === this.pid) {
      const wallNs = (now - this.prevCpu.t) * 1e6;
      if (wallNs > 0) {
        cpuPct = Math.max(0, (proc.cpuNs - this.prevCpu.cpuNs) / wallNs) * 100;
      }
    }
    this.prevCpu = proc ? { pid: this.pid, t: now, cpuNs: proc.cpuNs } : null;
    return {
      mem: this.probes.hostMemory(),
      pid: this.pid,
      proc,
      cpuPct,
      disk: this.disk,
    };
  }

  // Waits for an in-flight disk walk; tests use it, the loop never does.
  async settle(): Promise<void> {
    await this.diskScan;
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
      const host = this.probeHost();
      let sample: Sample;
      if (!reading) {
        sample = downSample(t, this.epoch, host);
        // a dead engine breaks the window: the next reading starts fresh
        // rather than computing rates over the outage
        this.prev = null;
        this.live = EMPTY_LIVE;
        this.models = [];
      } else {
        reading.t = t;
        // The restored previous reading (t=0 after a restart) only serves
        // the epoch check; its gauges are zero and its window meaningless.
        const restored = this.prev !== null && this.prev.t === 0;
        const rates = computeRates(this.prev, reading, this.epoch, this.live);
        this.live = rates.live;
        if (rates.epoch !== this.epoch) {
          this.log(
            `engine counters reset: epoch ${this.epoch} -> ${rates.epoch}`,
          );
          this.epoch = rates.epoch;
        }
        if (restored) {
          rates.ttftMs = null;
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
        sample = buildSample(reading, rates, this.models, host);
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
