// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Adapter for mlx-serve (github.com/ddalcu/mlx-serve) in --serve mode.
//
// Only endpoints that mlx-serve's dispatch answers before its model-load step
// are used here: /health, /metrics.json, /v1/models and, after a download,
// /v1/models/rescan (verified in the engine's src/server.zig). GET /props is NEVER called: it goes through the load path
// and cold-loads the default model, which is the bug that motivated mlx-spy.
// load/unload are explicit user actions, never called from the sampler.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildChatBody as buildOpenAiChatBody,
  chatEvents as openAiChatEvents,
  streamChat,
} from "./openai.ts";
import type {
  CacheLimits,
  Capability,
  ChatEvent,
  ChatProvider,
  ChatRequest,
  Engine,
  EngineMetrics,
  HistogramSummary,
  ModelInfo,
} from "./types.ts";

export {
  CHAT_HEADERS_TIMEOUT_MS,
  MAX_SSE_FRAME_BYTES,
  parseSse,
} from "./openai.ts";

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

export function buildChatBody(req: ChatRequest): Record<string, unknown> {
  const body = buildOpenAiChatBody(req);
  body.enable_thinking = req.thinking;
  if (req.thinking && req.reasoningEffort != null) {
    body.reasoning_effort = req.reasoningEffort;
  }
  return body;
}

export function chatEvents(json: string): ChatEvent[] {
  const events = openAiChatEvents(json);
  let timings: any;
  try {
    const body = JSON.parse(json);
    if (body?.timings && typeof body.timings === "object") {
      timings = body.timings;
    }
  } catch {
    return events;
  }
  if (!timings) return events;
  return events.map((event) => {
    if (event.kind !== "usage") return event;
    return {
      ...event,
      stats: {
        ...event.stats,
        cachedTokens:
          typeof timings.cached_n === "number"
            ? timings.cached_n
            : event.stats.cachedTokens,
        generated:
          typeof timings.predicted_n === "number"
            ? timings.predicted_n
            : event.stats.generated,
        prefillMs:
          typeof timings.prompt_ms === "number" ? timings.prompt_ms : null,
        decodeMs:
          typeof timings.predicted_ms === "number"
            ? timings.predicted_ms
            : null,
        tokenizeMs:
          typeof timings.tokenize_ms === "number" ? timings.tokenize_ms : null,
      },
    };
  });
}

// The sends the engine takes at once: one. mlx-serve 26.9.2 serializes
// generation for the Studio's MoE models (--max-concurrent is clamped to
// one for them, plans/26.09.10-parallel-chats-plan.md, 7), so a second
// send would only queue behind the first, silent until its first token.
export const CHAT_LIMIT = 1;

// The engine as the chat runner sees it: its chat method behind the
// provider contract, with the sampler's current list as the models
export function mlxServeProvider(
  engine: Engine,
  models: () => ModelInfo[],
  limit = CHAT_LIMIT,
): ChatProvider {
  const chat = engine.chat;
  if (!chat) throw new Error(`${engine.id} does not support chat`);
  return {
    id: "mlxserve",
    limit,
    models: () =>
      models().map((m) => ({ id: m.id, contextLength: m.contextLength })),
    chat: (req, signal) => chat.call(engine, req, signal),
  };
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
    yield* streamChat(
      `${this.url}/v1/chat/completions`,
      buildChatBody(req),
      signal,
      chatEvents,
    );
  }

  // Model ids are "<org>/<name>" in serve mode; callers pass the full id.
  async load(id: string, asDefault: boolean): Promise<void> {
    await this.post("/v1/load-model", { model: id, default: asDefault });
  }

  async unload(id: string): Promise<void> {
    await this.post("/v1/unload-model", { model: id });
  }

  // Discovery walks --model-dir at startup only; the rescan absorbs a
  // checkpoint added since. Answered before the model-load step, next to
  // /v1/models in the dispatch (src/server.zig), so it loads nothing.
  async rescan(): Promise<void> {
    await this.post("/v1/models/rescan", {});
  }

  capabilities(): Set<Capability> {
    return new Set([
      "chat",
      "load",
      "unload",
      "default",
      "restart",
      "diskClear",
      "rescan",
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
