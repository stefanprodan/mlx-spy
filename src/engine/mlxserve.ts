// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Adapter for mlx-serve (github.com/ddalcu/mlx-serve) in --serve mode.
//
// Only endpoints that mlx-serve's dispatch answers before its model-load step
// are used here: /health, /metrics.json, /v1/models (verified in the engine's
// src/server.zig). GET /props is NEVER called: it goes through the load path
// and cold-loads the default model, which is the bug that motivated mlx-spy.
// load/unload are explicit user actions, never called from the sampler.

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Capability,
  Engine,
  EngineMetrics,
  HistogramSummary,
  ModelInfo,
} from "./types.ts";

// Every request from the sampler must fail fast: a hung engine must not
// stall the 1 Hz loop, and a sample with engineUp=false is the right answer.
const TIMEOUT_MS = 3000;
// Loads can take seconds (mmap of tens of GB); unloads a few seconds too.
const ACTION_TIMEOUT_MS = 120_000;

const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

function hist(v: any): HistogramSummary {
  return { count: num(v?.count), sum: num(v?.sum) };
}

// Pure: the /metrics.json body → normalised metrics. Exported for tests.
export function parseMetrics(body: any): EngineMetrics {
  const c = body?.counters ?? {};
  const g = body?.gauges ?? {};
  const h = body?.histograms ?? {};
  return {
    counters: {
      promptTokens: num(c.prompt_tokens_total),
      prefillTokens: num(c.prefill_tokens_total),
      cachedPromptTokens: num(c.prefix_cache_tokens_total),
      generationTokens: num(c.generation_tokens_total),
      requestsSuccess: num(c.requests_success_total),
      requestsCancelled: num(c.requests_cancelled_total),
      cacheQueries: num(c.prefix_cache_queries_total),
      cacheHits: num(c.prefix_cache_hits_total),
    },
    gauges: {
      requestsRunning: num(g.requests_running),
      requestsWaiting: num(g.requests_waiting),
      requestsPrefilling: num(g.requests_prefilling),
      gpuPct: num(g.gpu_utilization_pct),
      // memory_mb is the process footprint in MiB
      memoryBytes: num(g.memory_mb) * 1024 * 1024,
      generationTokensLive: num(g.generation_tokens_live),
      prefillTokensLive: num(g.prefill_tokens_live),
      mlxActiveBytes: num(g.mlx_active_bytes),
      mlxCacheBytes: num(g.mlx_cache_bytes),
    },
    histograms: {
      ttftSeconds: hist(h.time_to_first_token_seconds),
      e2eLatencySeconds: hist(h.e2e_request_latency_seconds),
      prefillTimeSeconds: hist(h.prefill_time_seconds),
      decodeTimeSeconds: hist(h.decode_time_seconds),
      promptTokens: hist(h.prompt_tokens),
      outputTokens: hist(h.output_tokens),
    },
  };
}

// Pure: the /v1/models body → ModelInfo[]. Exported for tests. mlx-serve does
// not say which model is the default, so isDefault stays undefined.
export function parseModels(body: any): ModelInfo[] {
  const data: any[] = Array.isArray(body?.data) ? body.data : [];
  return data
    .filter((m) => typeof m?.id === "string")
    .map((m) => ({
      id: m.id,
      loaded: m.loaded === true,
      state:
        typeof m.state === "string" ? m.state : m.loaded ? "ready" : "unloaded",
      bytesResident: num(m.bytes_resident),
      bytesOnDisk: num(m.bytes_on_disk),
      contextLength:
        typeof m.context_length === "number" ? m.context_length : null,
      capabilities: Array.isArray(m.capabilities)
        ? m.capabilities.filter((c: unknown) => typeof c === "string")
        : [],
    }));
}

export class MlxServe implements Engine {
  readonly id = "mlxserve" as const;
  readonly url: string;

  constructor(url: string) {
    this.url = url.replace(/\/+$/, "");
  }

  private async get(path: string): Promise<any> {
    const res = await fetch(this.url + path, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(this.url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${path}: HTTP ${res.status} ${text}`.trim());
    }
  }

  async health(): Promise<boolean> {
    try {
      const j = await this.get("/health");
      return j?.status === "ok";
    } catch {
      return false;
    }
  }

  async models(): Promise<ModelInfo[]> {
    return parseModels(await this.get("/v1/models"));
  }

  async metrics(): Promise<EngineMetrics> {
    return parseMetrics(await this.get("/metrics.json"));
  }

  // Model ids are "<org>/<name>" in serve mode; callers pass the full id.
  async load(id: string, asDefault: boolean): Promise<void> {
    await this.post("/v1/load-model", { model: id, default: asDefault });
  }

  async unload(id: string): Promise<void> {
    await this.post("/v1/unload-model", { model: id });
  }

  capabilities(): Set<Capability> {
    return new Set(["load", "unload", "default", "restart", "diskClear"]);
  }

  // The SSD prefix cache tier: one <fingerprint>/ directory per model.
  cacheDirs(): string[] {
    return [join(homedir(), ".mlx-serve", "kv-cache")];
  }

  logFile(): string | null {
    const port = new URL(this.url).port || "80";
    return join(homedir(), ".mlx-serve", "logs", `mlx-serve-${port}.log`);
  }

  processNames(): string[] {
    return ["mlx-serve"];
  }
}
