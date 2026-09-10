// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// OpenRouter (openrouter.ai) as a chat provider: the OpenAI chat wire with
// a bearer key, the reasoning object in place of enable_thinking, usage
// with cost on the last frame, and a public catalog that prices every
// model. It runs many requests at once, so its cap is its own
// (plans/26.09.10-openrouter-plan.md). Nothing here touches the engine.
//
// Verified on 2026-09-10 against the live API (test/fixtures/openrouter/):
// reasoning streams as delta.reasoning, tool calls in the OpenAI shape,
// usage rides on a final chunk that repeats the finish reason, keep-alive
// comments precede the first token, and a free endpoint refuses with an
// HTTP 429 whose body names the upstream pool.

import type { RemoteModel } from "../config.ts";
import {
  buildChatBody as buildOpenAiChatBody,
  chatEvents,
  streamChat,
} from "./openai.ts";
import type {
  ChatEvent,
  ChatModel,
  ChatProvider,
  ChatRequest,
  ReasoningDetail,
} from "./types.ts";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";
// the catalog is public and about 700 KB; the page waits on it when it
// opens, so the timeout is short and a miss keeps the stored rows
export const CATALOG_TIMEOUT_MS = 10_000;
export const DEFAULT_LIMIT = 4;

// One catalog entry, as the config page and the table keep it. Prices are
// USD per million tokens (the catalog quotes per token, as strings).
export type CatalogModel = {
  id: string;
  name: string;
  contextLength: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
  tools: boolean;
  reasoning: boolean;
};

const perMillion = (value: unknown): number | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : null;
};

// Pure: the /models body to a map by id. Exported for tests.
export function parseCatalog(body: unknown): Map<string, CatalogModel> {
  const out = new Map<string, CatalogModel>();
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return out;
  for (const m of data as any[]) {
    if (typeof m?.id !== "string" || m.id === "") continue;
    const params: unknown[] = Array.isArray(m.supported_parameters)
      ? m.supported_parameters
      : [];
    out.set(m.id, {
      id: m.id,
      name: typeof m.name === "string" && m.name !== "" ? m.name : m.id,
      contextLength:
        typeof m.context_length === "number" && m.context_length > 0
          ? m.context_length
          : null,
      promptPrice: perMillion(m.pricing?.prompt),
      completionPrice: perMillion(m.pricing?.completion),
      tools: params.includes("tools"),
      reasoning: params.includes("reasoning"),
    });
  }
  return out;
}

export class CatalogError extends Error {}

export async function fetchCatalog(
  fetcher: typeof fetch = fetch,
): Promise<Map<string, CatalogModel>> {
  let res: Response;
  try {
    res = await fetcher(`${OPENROUTER_URL}/models`, {
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CatalogError(
      `OpenRouter unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw new CatalogError(`OpenRouter catalog: HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new CatalogError("OpenRouter catalog: not JSON");
  }
  const catalog = parseCatalog(body);
  if (catalog.size === 0) throw new CatalogError("OpenRouter catalog: empty");
  return catalog;
}

// The catalog as the routes use it: a check reuses the last fetch for a
// minute, a refresh (the config page opening) always fetches.
export class Catalog {
  private cached: { at: number; models: Map<string, CatalogModel> } | null =
    null;
  private inflight: Promise<Map<string, CatalogModel>> | null = null;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 60_000,
  ) {}

  last(): Map<string, CatalogModel> | null {
    return this.cached?.models ?? null;
  }

  get(fresh = false): Promise<Map<string, CatalogModel>> {
    const cached = this.cached;
    if (!fresh && cached && this.now() - cached.at < this.ttlMs) {
      return Promise.resolve(cached.models);
    }
    if (this.inflight) return this.inflight;
    this.inflight = fetchCatalog(this.fetcher)
      .then((models) => {
        this.cached = { at: this.now(), models };
        return models;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}

// The breakpoints an Anthropic upstream caches at (Gemini takes them
// too; the rest ignore them): the system prompt, then the last two turns,
// so the previous turn's prefix is read while this turn's is written.
// A breakpoint needs the content as parts; the rest stay strings, so a
// body without breakpoints is the plain wire.
export const CACHE_BREAKPOINTS = 2;
export function withCacheBreakpoints(
  messages: Record<string, unknown>[],
): Record<string, unknown>[] {
  const marked = new Set<number>();
  messages.forEach((m, i) => {
    if (m.role === "system") marked.add(i);
  });
  let tail = CACHE_BREAKPOINTS;
  for (let i = messages.length - 1; i >= 0 && tail > 0; i--) {
    if (messages[i]!.role === "system") continue;
    if (typeof messages[i]!.content !== "string") continue;
    marked.add(i);
    tail--;
  }
  return messages.map((m, i) =>
    marked.has(i) && typeof m.content === "string"
      ? {
          ...m,
          content: [
            {
              type: "text",
              text: m.content,
              cache_control: { type: "ephemeral" },
            },
          ],
        }
      : m,
  );
}

// The stream repeats each item's index on every piece: the text grows
// piece by piece and the signature lands on a late one, so pieces with
// one index and type are merged into one item, in arrival order.
export function mergeReasoningDetail(
  items: ReasoningDetail[],
  piece: ReasoningDetail,
): ReasoningDetail[] {
  const at = items.findIndex(
    (item) =>
      item.type === piece.type &&
      typeof item.index === "number" &&
      item.index === piece.index,
  );
  if (at < 0) return [...items, { ...piece }];
  const merged: ReasoningDetail = { ...items[at]! };
  for (const [field, value] of Object.entries(piece)) {
    if (
      (field === "text" || field === "summary" || field === "data") &&
      typeof value === "string" &&
      typeof merged[field] === "string"
    ) {
      merged[field] = `${merged[field]}${value}`;
    } else if (value !== null && value !== undefined && value !== "") {
      merged[field] = value;
    }
  }
  return items.map((item, i) => (i === at ? merged : item));
}

// The request body: the shared wire, reasoning as OpenRouter's object,
// usage asked for on the last frame, the chat id as session_id (the
// sticky routing key: every turn goes to the upstream that holds the
// cached prefix; prompt_cache_key is only its fallback) and cache
// breakpoints on the messages.
export function buildChatBody(req: ChatRequest): Record<string, unknown> {
  const body = buildOpenAiChatBody(req, { reasoningField: "reasoning" });
  delete body.prompt_cache_key;
  delete body.stream_options;
  if (req.cacheKey) body.session_id = req.cacheKey;
  body.usage = { include: true };
  body.messages = withCacheBreakpoints(
    body.messages as Record<string, unknown>[],
  );
  // "none" is an effort OpenRouter knows (an explicit off), so every set
  // effort goes through as is
  body.reasoning = req.thinking
    ? req.reasoningEffort
      ? { effort: req.reasoningEffort }
      : { enabled: true }
    : { exclude: true, enabled: false };
  return body;
}

// The error body of a refused request, as OpenRouter writes it: the
// upstream's own words when it has them, else the message.
export function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const error = parsed?.error;
    const raw = error?.metadata?.raw;
    if (typeof raw === "string" && raw !== "") return raw;
    if (typeof error?.message === "string" && error.message !== "") {
      return error.message;
    }
  } catch {}
  return body;
}

export function openRouterEvents(json: string): ChatEvent[] {
  return chatEvents(json);
}

export type OpenRouterDeps = {
  key: string;
  models: () => RemoteModel[];
  limit?: number;
  url?: string;
};

export class OpenRouter implements ChatProvider {
  readonly id = "openrouter" as const;
  readonly limit: number;
  private readonly url: string;

  constructor(private readonly deps: OpenRouterDeps) {
    this.limit = deps.limit ?? DEFAULT_LIMIT;
    this.url = (deps.url ?? OPENROUTER_URL).replace(/\/+$/, "");
  }

  models(): ChatModel[] {
    return this.deps
      .models()
      .map((m) => ({ id: m.id, contextLength: m.contextLength }));
  }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    for await (const event of streamChat(
      `${this.url}/chat/completions`,
      buildChatBody(req),
      signal,
      openRouterEvents,
      {
        authorization: `Bearer ${this.deps.key}`,
        "http-referer": "https://github.com/stefanprodan/mlx-spy",
        "x-title": "mlx-spy",
      },
    )) {
      if (event.kind === "error") {
        // the HTTP error path joins the status and the body; the body is
        // OpenRouter's JSON, whose upstream text is what the user needs.
        // Whatever the text, the key never rides in it
        const m = /^HTTP (\d+): (.*)$/s.exec(event.message);
        const message = m
          ? `OpenRouter ${m[1]}: ${errorText(m[2])}`
          : event.message;
        yield {
          kind: "error",
          message: message.replaceAll(this.deps.key, "[key]"),
        };
        continue;
      }
      yield event;
    }
  }
}
