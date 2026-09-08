// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// HTTP API and WebSocket push over the sampler, history, actions and chat
// runner. The page is an HTML import passed from main.ts so tests can import
// this module without invoking Bun's bundler.

import { networkInterfaces } from "node:os";
import type { HTMLBundle } from "bun";
import { ActionError, type ActionEvent, type Actions } from "./actions.ts";
import { ChatError, type ChatRunner, type ChatWsEvent } from "./chat.ts";
import type { ChatPatch, ChatSettings } from "./chats.ts";
import type { CacheLimits, Engine } from "./engine/types.ts";
import { type History, RANGES, type Range } from "./history.ts";
import { diskSpace, type HostInfo } from "./host/info.ts";
import type { Sample } from "./sample.ts";
import type { Sampler } from "./sampler.ts";
import { TOOLS } from "./tools.ts";

export const DEFAULT_PORT = 11235;
const SAMPLES_TOPIC = "samples";
const MAX_BODY_BYTES = 256 * 1024;

export function tailscaleAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const address of addrs ?? []) {
      if (address.family !== "IPv4") continue;
      const [o1, o2] = address.address.split(".").map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return address.address;
    }
  }
  return null;
}

export function isRange(value: string | null): value is Range {
  return value !== null && value in RANGES;
}

export type WebDeps = {
  engine: Engine;
  sampler: Sampler;
  history: History;
  actions: Actions;
  chat: ChatRunner;
  version: string;
  local: boolean;
  limits: CacheLimits | null;
  host: HostInfo | null;
  now?: () => number;
};

// handle() also serves old focused tests that do not exercise chat. Production
// serve() requires the runner through WebDeps.
type HandleDeps = Omit<WebDeps, "chat"> & { chat?: ChatRunner };

export function snapshot(deps: HandleDeps) {
  return {
    version: deps.version,
    engine: {
      id: deps.engine.id,
      url: deps.engine.url,
      local: deps.local,
      capabilities: [...deps.engine.capabilities()],
      limits: deps.limits,
    },
    host: deps.host
      ? { ...deps.host, disk: diskSpace(deps.host.diskPath) }
      : null,
    sample: deps.history.latest(),
    models: deps.sampler.currentModels(),
    disk: deps.sampler.currentDisk(),
    events: deps.actions.events,
    running: deps.actions.running(),
    chat: deps.chat?.running() ?? null,
  };
}

export type WsMessage =
  | { type: "snapshot"; data: ReturnType<typeof snapshot> }
  | { type: "sample"; data: Sample }
  | { type: "event"; data: ActionEvent }
  | { type: "chat"; data: ChatWsEvent };

export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

async function body(
  req: Request,
  empty = false,
): Promise<Record<string, unknown>> {
  const length = Number(req.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    throw new HttpError(400, "body must be at most 256 KB");
  }
  if (!req.body) {
    if (empty) return {};
    throw new HttpError(400, "body must be a JSON object");
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(400, "body must be at most 256 KB");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === "") {
    if (empty) return {};
    throw new HttpError(400, "body must be a JSON object");
  }
  try {
    return object(JSON.parse(text));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "body is not JSON");
  }
}

function stringField(
  value: Record<string, unknown>,
  name: string,
  required = false,
): string | undefined {
  const field = value[name];
  if (field === undefined && !required) return undefined;
  if (typeof field !== "string" || (required && field === "")) {
    throw new HttpError(400, `${name} must be a string`);
  }
  return field;
}

function booleanField(
  value: Record<string, unknown>,
  name: string,
): boolean | undefined {
  const field = value[name];
  if (field === undefined) return undefined;
  if (typeof field !== "boolean") {
    throw new HttpError(400, `${name} must be a boolean`);
  }
  return field;
}

function numberField(
  value: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
  integer = false,
): number | null | undefined {
  const field = value[name];
  if (field === undefined || field === null) return field;
  if (
    typeof field !== "number" ||
    !Number.isFinite(field) ||
    field < min ||
    field > max ||
    (integer && !Number.isInteger(field))
  ) {
    const range =
      max === Number.MAX_SAFE_INTEGER ? `at least ${min}` : `${min}..${max}`;
    throw new HttpError(400, `${name} must be ${range}`);
  }
  return field;
}

function effortField(
  value: Record<string, unknown>,
): string | null | undefined {
  const effort = value.reasoningEffort;
  if (effort === undefined || effort === null) return effort;
  if (!["low", "medium", "high", "none"].includes(String(effort))) {
    throw new HttpError(
      400,
      "reasoningEffort must be low, medium, high, none or null",
    );
  }
  return effort as string;
}

function toolsField(value: Record<string, unknown>): string[] | undefined {
  const field = value.toolsOff;
  if (field === undefined) return undefined;
  if (!Array.isArray(field) || field.some((name) => typeof name !== "string")) {
    throw new HttpError(400, "toolsOff must be an array of tool names");
  }
  const known = new Set(TOOLS.map((tool) => tool.name));
  for (const name of field as string[]) {
    if (!known.has(name)) {
      throw new HttpError(400, `unknown tool: ${name}`);
    }
  }
  return [...new Set(field as string[])];
}

function settings(value: Record<string, unknown>): ChatSettings {
  return {
    model: stringField(value, "model", true)!,
    systemPrompt: stringField(value, "systemPrompt") ?? "",
    thinking: booleanField(value, "thinking") ?? true,
    reasoningEffort: effortField(value) ?? null,
    temperature: numberField(value, "temperature", 0, 2) ?? null,
    topP: numberField(value, "topP", 0, 1) ?? null,
    maxTokens:
      numberField(value, "maxTokens", 1, Number.MAX_SAFE_INTEGER, true) ?? null,
    toolsOff: toolsField(value) ?? [],
  };
}

function patch(value: Record<string, unknown>): ChatPatch {
  const result: ChatPatch = {};
  const title = stringField(value, "title");
  const model = stringField(value, "model");
  const systemPrompt = stringField(value, "systemPrompt");
  const thinking = booleanField(value, "thinking");
  const reasoningEffort = effortField(value);
  const temperature = numberField(value, "temperature", 0, 2);
  const topP = numberField(value, "topP", 0, 1);
  const maxTokens = numberField(
    value,
    "maxTokens",
    1,
    Number.MAX_SAFE_INTEGER,
    true,
  );
  const toolsOff = toolsField(value);
  if (title !== undefined) result.title = title;
  if (model !== undefined) result.model = model;
  if (systemPrompt !== undefined) result.systemPrompt = systemPrompt;
  if (thinking !== undefined) result.thinking = thinking;
  if (reasoningEffort !== undefined) result.reasoningEffort = reasoningEffort;
  if (temperature !== undefined) result.temperature = temperature;
  if (topP !== undefined) result.topP = topP;
  if (maxTokens !== undefined) result.maxTokens = maxTokens;
  if (toolsOff !== undefined) result.toolsOff = toolsOff;
  return result;
}

async function actionRoute(
  req: Request,
  deps: HandleDeps,
  name: string,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const requestBody = await body(req, true);
  try {
    return json(await deps.actions.run(name, requestBody));
  } catch (err) {
    if (err instanceof ActionError) {
      return json({ error: err.message }, err.status);
    }
    throw err;
  }
}

async function chatsRoute(req: Request, deps: HandleDeps): Promise<Response> {
  const runner = deps.chat;
  if (!runner) return json({ error: "not found" }, 404);
  const url = new URL(req.url);
  if (url.pathname === "/api/chats") {
    if (req.method === "GET") return json(runner.list());
    if (req.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }
    const value = await body(req);
    const chat = runner.create(
      settings(value),
      stringField(value, "title") ?? "",
    );
    return json(chat, 201);
  }

  const match =
    /^\/api\/chats\/([^/]+)(?:\/(messages|regenerate|edit|stop))?$/.exec(
      url.pathname,
    );
  if (!match) return json({ error: "not found" }, 404);
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return json({ error: "not found" }, 404);
  }
  const operation = match[2];
  if (!operation) {
    if (req.method === "GET") {
      const chat = runner.get(id);
      return chat ? json(chat) : json({ error: "Chat not found" }, 404);
    }
    if (req.method === "PATCH") {
      const updated = runner.update(id, patch(await body(req)));
      return updated ? json(updated) : json({ error: "Chat not found" }, 404);
    }
    if (req.method === "DELETE") {
      return runner.remove(id)
        ? json({ ok: true })
        : json({ error: "Chat not found" }, 404);
    }
    return json({ error: "method not allowed" }, 405);
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!runner.get(id)) return json({ error: "Chat not found" }, 404);
  if (operation === "messages") {
    const value = await body(req);
    const content = stringField(value, "content", true)!;
    return json(runner.send(id, content), 202);
  }
  if (operation === "edit") {
    const value = await body(req);
    const messageId = value.messageId;
    if (!Number.isInteger(messageId) || Number(messageId) <= 0) {
      throw new HttpError(400, "messageId must be a positive integer");
    }
    const content = stringField(value, "content", true)!;
    return json(runner.edit(id, Number(messageId), content), 202);
  }
  if (operation === "regenerate") {
    await body(req, true);
    return json(runner.regenerate(id), 202);
  }
  await body(req, true);
  runner.stop(id);
  return json({ ok: true });
}

export async function handle(
  req: Request,
  deps: HandleDeps,
): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "GET" && !sameOrigin(req)) {
    return json({ error: "cross-origin request" }, 403);
  }
  try {
    const action = /^\/api\/actions\/([a-zA-Z]+)$/.exec(url.pathname);
    if (action) return await actionRoute(req, deps, action[1]);
    if (
      url.pathname === "/api/chats" ||
      url.pathname.startsWith("/api/chats/")
    ) {
      return await chatsRoute(req, deps);
    }
    if (req.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }
    if (url.pathname === "/api/tools") {
      return json(
        TOOLS.map(({ name, description }) => ({ name, description })),
      );
    }
    switch (url.pathname) {
      case "/api/snapshot":
        return json(snapshot(deps));
      case "/api/requests":
        return json(deps.history.requests());
      case "/api/history": {
        const range = url.searchParams.get("range") ?? "1h";
        if (!isRange(range)) {
          return json(
            { error: `range must be one of ${Object.keys(RANGES).join(", ")}` },
            400,
          );
        }
        return json({
          range,
          series: deps.history.series(range, (deps.now ?? Date.now)()),
        });
      }
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (err) {
    if (err instanceof ChatError || err instanceof HttpError) {
      return json({ error: err.message }, err.status);
    }
    throw err;
  }
}

export function serve(
  deps: WebDeps,
  listen: { hostname: string; port: number },
  page: HTMLBundle,
) {
  const server = Bun.serve({
    hostname: listen.hostname,
    port: listen.port,
    // MLX_SPY_DEV=1 (make preview) turns on Bun's dev server: the page's
    // CSS and TypeScript are bundled on demand and hot-reloaded in the
    // browser; off, the bundle is built once at startup
    development: process.env.MLX_SPY_DEV === "1",
    routes: {
      "/": page,
      "/requests": page,
      "/chat": page,
      "/chat/*": page,
    },
    fetch(req, server) {
      if (new URL(req.url).pathname === "/ws") {
        if (!sameOrigin(req)) {
          return new Response("cross-origin request", { status: 403 });
        }
        return server.upgrade(req)
          ? undefined
          : new Response("websocket upgrade failed", { status: 400 });
      }
      return handle(req, deps);
    },
    websocket: {
      open(ws) {
        ws.subscribe(SAMPLES_TOPIC);
        const message: WsMessage = { type: "snapshot", data: snapshot(deps) };
        ws.send(JSON.stringify(message));
      },
      message() {},
      close(ws) {
        ws.unsubscribe(SAMPLES_TOPIC);
      },
    },
  });
  const publish = (message: WsMessage) =>
    server.publish(SAMPLES_TOPIC, JSON.stringify(message));
  const unsubscribe = deps.sampler.onSample((sample) =>
    publish({ type: "sample", data: sample }),
  );
  const unsubscribeEvents = deps.actions.onEvent((event) =>
    publish({ type: "event", data: event }),
  );
  const unsubscribeChat = deps.chat.onEvent((event) =>
    publish({ type: "chat", data: event }),
  );
  return {
    server,
    stop() {
      unsubscribe();
      unsubscribeEvents();
      unsubscribeChat();
      server.stop(true);
    },
  };
}
