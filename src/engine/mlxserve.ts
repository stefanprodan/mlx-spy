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
  CacheLimits,
  Capability,
  ChatEvent,
  ChatRequest,
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
export const CHAT_HEADERS_TIMEOUT_MS = 30_000;
const CHAT_SILENCE_TIMEOUT_MS = 5 * 60_000;
export const MAX_SSE_FRAME_BYTES = 1024 * 1024;
const CHAT_ERROR_BODY_MAX_BYTES = 4 * 1024;
const CHAT_ERROR_BODY_TIMEOUT_MS = 10_000;
const OVERSIZED_SSE_FRAME = "engine sent an oversized stream frame";

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

export function buildChatBody(req: ChatRequest) {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.role === "assistant" && message.reasoning
        ? { reasoning_content: message.reasoning }
        : {}),
    })),
    enable_thinking: req.thinking,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.thinking && req.reasoningEffort != null) {
    body.reasoning_effort = req.reasoningEffort;
  }
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.topP != null) body.top_p = req.topP;
  if (req.maxTokens != null) body.max_tokens = req.maxTokens;
  return body;
}

// Frames are returned as their joined data payload. Comments count as bytes
// for liveness in the reader but carry no event for the runner.
export function parseSse(
  buffer: string,
  chunk: string,
): { frames: string[]; rest: string } {
  let rest = buffer + chunk;
  const frames: string[] = [];
  while (true) {
    const split = /\r?\n\r?\n/.exec(rest);
    if (!split || split.index === undefined) break;
    const raw = rest.slice(0, split.index);
    if (new TextEncoder().encode(raw).byteLength > MAX_SSE_FRAME_BYTES) {
      throw new Error(OVERSIZED_SSE_FRAME);
    }
    rest = rest.slice(split.index + split[0].length);
    const data = raw
      .split(/\r?\n/)
      .filter((line) => !line.startsWith(":"))
      .filter((line) => line === "data" || line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (data.length > 0) frames.push(data.join("\n"));
  }
  if (new TextEncoder().encode(rest).byteLength > MAX_SSE_FRAME_BYTES) {
    throw new Error(OVERSIZED_SSE_FRAME);
  }
  return { frames, rest };
}

async function readErrorBody(
  response: Response,
  controller: AbortController,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  type ReadResult =
    | { kind: "read"; done: boolean; value?: Uint8Array }
    | { kind: "timeout" };
  const timeout = new Promise<ReadResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "timeout" }),
      CHAT_ERROR_BODY_TIMEOUT_MS,
    );
  });
  try {
    while (size < CHAT_ERROR_BODY_MAX_BYTES) {
      const read: Promise<ReadResult> = reader.read().then((result) => ({
        kind: "read",
        done: result.done,
        value: result.value,
      }));
      const result = await Promise.race([read, timeout]);
      if (result.kind === "timeout") {
        controller.abort(new Error("engine error body timed out"));
        return "";
      }
      if (result.done || !result.value) break;
      const remaining = CHAT_ERROR_BODY_MAX_BYTES - size;
      const chunk = result.value.subarray(0, remaining);
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
  } catch {
    return "";
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function chatEvents(json: string): ChatEvent[] {
  if (json.trim() === "[DONE]") return [];
  let body: any;
  try {
    body = JSON.parse(json);
  } catch {
    return [{ kind: "error", message: "invalid JSON in engine stream" }];
  }
  if (body?.error) {
    const message =
      typeof body.error.message === "string"
        ? body.error.message
        : typeof body.error === "string"
          ? body.error
          : "engine generation failed";
    return [{ kind: "error", message }];
  }
  const events: ChatEvent[] = [];
  const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
  const delta = choice?.delta;
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
    events.push({ kind: "reasoning", text: delta.reasoning_content });
  }
  if (typeof delta?.content === "string" && delta.content) {
    events.push({ kind: "content", text: delta.content });
  }
  if (typeof choice?.finish_reason === "string") {
    events.push({
      kind: "finish",
      reason: choice.finish_reason,
      details:
        typeof choice.finish_details?.type === "string"
          ? choice.finish_details.type
          : null,
    });
  }
  if (
    body?.usage &&
    Array.isArray(body?.choices) &&
    body.choices.length === 0
  ) {
    const usage = body.usage;
    const timings = body.timings ?? {};
    events.push({
      kind: "usage",
      stats: {
        promptTokens: num(usage.prompt_tokens),
        cachedTokens:
          typeof usage.prompt_tokens_details?.cached_tokens === "number"
            ? usage.prompt_tokens_details.cached_tokens
            : num(timings.cached_n),
        generated:
          typeof timings.predicted_n === "number"
            ? timings.predicted_n
            : num(usage.completion_tokens),
        prefillMs: num(timings.prompt_ms),
        decodeMs: num(timings.predicted_ms),
        tokenizeMs:
          typeof timings.tokenize_ms === "number" ? timings.tokenize_ms : null,
      },
    });
  }
  return events;
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

  // A 200 with the wrong shape (a proxy page, a half-written body) is an
  // error, not an empty list or zeroed counters: the latter would drop the
  // favorite and fake a counter reset.
  async models(): Promise<ModelInfo[]> {
    const body = await this.get("/v1/models");
    if (!Array.isArray(body?.data)) throw new Error("/v1/models: no data");
    return parseModels(body);
  }

  async metrics(): Promise<EngineMetrics> {
    const body = await this.get("/metrics.json");
    if (
      typeof body?.counters !== "object" ||
      typeof body?.gauges !== "object"
    ) {
      throw new Error("/metrics.json: no counters");
    }
    return parseMetrics(body);
  }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const headersTimer = setTimeout(
      () => controller.abort(new Error("engine response headers timed out")),
      CHAT_HEADERS_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetch(`${this.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildChatBody(req)),
        signal: combined,
      });
    } finally {
      clearTimeout(headersTimer);
    }
    if (!response.ok) {
      const text = await readErrorBody(response, controller);
      yield {
        kind: "error",
        message: `HTTP ${response.status}${text ? `: ${text}` : ""}`,
      };
      return;
    }
    if (!response.body) {
      yield { kind: "error", message: "engine response has no stream" };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let rest = "";
    try {
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const read = reader.read().then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        const silence = new Promise<{ silent: true }>((resolve) => {
          timer = setTimeout(
            () => resolve({ silent: true }),
            CHAT_SILENCE_TIMEOUT_MS,
          );
        });
        const result = await Promise.race([read, silence]);
        if (timer) clearTimeout(timer);
        if ("silent" in result) {
          controller.abort(new Error("engine silent for 5 min"));
          yield { kind: "error", message: "engine silent for 5 min" };
          return;
        }
        if ("error" in result) throw result.error;
        if (result.value.done) break;
        let parsed: ReturnType<typeof parseSse>;
        try {
          parsed = parseSse(
            rest,
            decoder.decode(result.value.value, {
              stream: true,
            }),
          );
        } catch (err) {
          if (!(err instanceof Error) || err.message !== OVERSIZED_SSE_FRAME) {
            throw err;
          }
          controller.abort(err);
          yield { kind: "error", message: OVERSIZED_SSE_FRAME };
          return;
        }
        rest = parsed.rest;
        for (const frame of parsed.frames) {
          if (frame.trim() === "[DONE]") return;
          for (const event of chatEvents(frame)) yield event;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  // Model ids are "<org>/<name>" in serve mode; callers pass the full id.
  async load(id: string, asDefault: boolean): Promise<void> {
    await this.post("/v1/load-model", { model: id, default: asDefault });
  }

  async unload(id: string): Promise<void> {
    await this.post("/v1/unload-model", { model: id });
  }

  capabilities(): Set<Capability> {
    return new Set([
      "chat",
      "load",
      "unload",
      "default",
      "restart",
      "diskClear",
    ]);
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

  // The LaunchAgent from the homelab notes; a fresh process has no default
  // model, so a restart is the reliable way to free the RAM.
  serviceLabel(): string {
    return "com.ddalcu.mlx-serve";
  }

  // The budgets are launch flags on the LaunchAgent and no endpoint reports
  // them (only /props would, and that is off limits), so read the plist.
  async cacheLimits(): Promise<CacheLimits | null> {
    const plist = join(
      homedir(),
      "Library",
      "LaunchAgents",
      `${this.serviceLabel()}.plist`,
    );
    try {
      const args = parseLaunchdArgs(await Bun.file(plist).text());
      return args.length ? limitsFromArgs(args) : null;
    } catch {
      return null;
    }
  }
}

// ---------- launch configuration ----------

// mlx-serve's own size grammar (parseSizeArg in main.zig): <n>{KB,MB,GB},
// a bare number of bytes, or "0"/"off". Binary units, as the engine uses.
export function parseSize(s: string): number | null {
  const v = s.trim();
  if (v === "off" || v === "0") return 0;
  const m = /^(\d+)\s*(KB|MB|GB|B)?$/i.exec(v);
  if (!m) return null;
  const unit = (m[2] ?? "B").toUpperCase();
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[unit] ?? 1;
  return Number(m[1]) * mult;
}

// The <string> children of the ProgramArguments array in a launchd plist.
// The plist is our own XML file, so a scan for the array after the key is
// enough; a binary plist yields no arguments.
export function parseLaunchdArgs(xml: string): string[] {
  const key = xml.indexOf("<key>ProgramArguments</key>");
  if (key === -1) return [];
  const start = xml.indexOf("<array>", key);
  const end = xml.indexOf("</array>", start);
  if (start === -1 || end === -1) return [];
  const body = xml.slice(start, end);
  return [...body.matchAll(/<string>([^<]*)<\/string>/g)].map((m) =>
    m[1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&"),
  );
}

// Hot budget defaults to 2 GB and the SSD tier to off, as in mlx-serve.
export function limitsFromArgs(args: string[]): CacheLimits {
  const limits: CacheLimits = { hotBytes: 2 * 1024 ** 3, diskBytes: 0 };
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = args[i].split(/=(.*)/s);
    if (name !== "--prefix-cache-mem" && name !== "--prefix-cache-disk") {
      continue;
    }
    const raw = inline ?? args[++i];
    const bytes = raw === undefined ? null : parseSize(raw);
    if (bytes === null) continue;
    if (name === "--prefix-cache-mem") limits.hotBytes = bytes;
    else limits.diskBytes = bytes;
  }
  return limits;
}
