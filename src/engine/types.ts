// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The engine adapter contract. Everything mlx-spy knows about an inference
// server goes through this interface, so a second engine is a new file under
// src/engine/, not a rewrite. Names are normalised here: adapters translate
// their server's counter names into these fields.

export type EngineId = "mlxserve" | "omlx";

export type Capability =
  | "load"
  | "unload"
  | "default"
  | "restart"
  | "diskClear";

export type ModelInfo = {
  id: string;
  loaded: boolean;
  state: string; // engine's own word: "ready", "unloaded", "loading", ...
  bytesResident: number;
  bytesOnDisk: number;
  contextLength: number | null;
  // undefined when the engine does not expose which model is its default
  isDefault?: boolean;
};

// Monotonic counters. All reset to zero when the engine process restarts;
// the sampler detects that as a new epoch.
export type EngineCounters = {
  promptTokens: number; // every prompt token, cached or not
  prefillTokens: number; // prompt tokens actually computed
  cachedPromptTokens: number; // prompt tokens served from the prefix cache
  generationTokens: number;
  requestsSuccess: number;
  requestsCancelled: number;
  cacheQueries: number;
  cacheHits: number;
};

export type EngineGauges = {
  requestsRunning: number;
  requestsWaiting: number;
  requestsPrefilling: number;
  gpuPct: number;
  // the engine process footprint as the engine reports it (bytes)
  memoryBytes: number;
  // tokens of the current (or last) request; advance while it runs
  generationTokensLive: number;
  prefillTokensLive: number;
  // allocator view: active is what MLX holds for weights + KV, cache is
  // MLX's reclaimable buffer pool (not the prefix cache)
  mlxActiveBytes: number;
  mlxCacheBytes: number;
};

export type HistogramSummary = { count: number; sum: number };

export type EngineHistograms = {
  ttftSeconds: HistogramSummary;
  e2eLatencySeconds: HistogramSummary;
  prefillTimeSeconds: HistogramSummary;
  decodeTimeSeconds: HistogramSummary;
  promptTokens: HistogramSummary;
  outputTokens: HistogramSummary;
};

export type EngineMetrics = {
  counters: EngineCounters;
  gauges: EngineGauges;
  histograms: EngineHistograms;
};

export interface Engine {
  readonly id: EngineId;
  readonly url: string;
  health(): Promise<boolean>;
  models(): Promise<ModelInfo[]>;
  metrics(): Promise<EngineMetrics>;
  load(id: string, asDefault: boolean): Promise<void>;
  unload(id: string): Promise<void>;
  capabilities(): Set<Capability>;
  // disk tier locations, sized by the host probes
  cacheDirs(): string[];
  // per-request log to tail, null when the engine has none
  logFile(): string | null;
  // executable basenames the host probe may match for the engine's pid
  processNames(): string[];
}
