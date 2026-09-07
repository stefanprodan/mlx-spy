// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// HTTP API and WebSocket push over the sampler, history and actions. The
// page itself is an HTML import bundled by Bun (passed in from main.ts so
// this module stays importable from tests without the bundler).

import { networkInterfaces } from "node:os";
import type { HTMLBundle } from "bun";
import { ActionError, type ActionEvent, type Actions } from "./actions.ts";
import type { CacheLimits, Engine } from "./engine/types.ts";
import { type History, RANGES, type Range } from "./history.ts";
import { diskSpace, type HostInfo } from "./host/info.ts";
import type { Sample } from "./sample.ts";
import type { Sampler } from "./sampler.ts";

export const DEFAULT_PORT = 11235;
// pub/sub topic every dashboard tab subscribes to
const SAMPLES_TOPIC = "samples";

// The tailnet is the auth boundary, so the default bind is the Tailscale
// address (CGNAT range 100.64.0.0/10) when the host has one, else loopback.
export function tailscaleAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4") continue;
      const [o1, o2] = a.address.split(".").map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return a.address;
    }
  }
  return null;
}

export function isRange(v: string | null): v is Range {
  return v !== null && v in RANGES;
}

export type WebDeps = {
  engine: Engine;
  sampler: Sampler;
  history: History;
  actions: Actions;
  version: string;
  local: boolean;
  // per-model cache budgets, null when unknown
  limits: CacheLimits | null;
  // facts about the host mlx-spy runs on; null in tests
  host: HostInfo | null;
  // injectable for tests; the history range is relative to it
  now?: () => number;
};

export function snapshot(deps: WebDeps) {
  return {
    version: deps.version,
    engine: {
      id: deps.engine.id,
      url: deps.engine.url,
      local: deps.local,
      capabilities: [...deps.engine.capabilities()],
      limits: deps.limits,
    },
    // the disk changes, the rest does not; a snapshot is rare enough for a statfs
    host: deps.host
      ? { ...deps.host, disk: diskSpace(deps.host.diskPath) }
      : null,
    sample: deps.history.latest(),
    models: deps.sampler.currentModels(),
    disk: deps.sampler.currentDisk(),
    events: deps.actions.events,
    running: deps.actions.running(),
  };
}

// What a tab receives on connect, then one "sample" message per tick and an
// "event" whenever an action finishes (in any tab).
export type WsMessage =
  | { type: "snapshot"; data: ReturnType<typeof snapshot> }
  | { type: "sample"; data: Sample }
  | { type: "event"; data: ActionEvent };

// There is no auth, so a page on any other site that a tailnet user has
// open could post an action or read the push from the browser. A browser
// sends Origin on POSTs and WebSocket upgrades: when present it must be the
// dashboard's own; curl and scripts send none and are the tailnet's own.
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

// live data, never cached by the browser or a proxy
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

// Route handler, separate from Bun.serve so tests can call it with a Request.
export async function handle(req: Request, deps: WebDeps): Promise<Response> {
  const url = new URL(req.url);
  const action = /^\/api\/actions\/([a-zA-Z]+)$/.exec(url.pathname);
  if (action) {
    if (req.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }
    if (!sameOrigin(req)) return json({ error: "cross-origin request" }, 403);
    // an empty body is fine for free and diskClear; a body must be JSON
    const text = await req.text();
    let body: unknown = {};
    if (text.trim() !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        return json({ error: "body is not JSON" }, 400);
      }
      if (typeof body !== "object" || body === null) {
        return json({ error: "body must be a JSON object" }, 400);
      }
    }
    try {
      return json(await deps.actions.run(action[1], body));
    } catch (err) {
      if (err instanceof ActionError) {
        return json({ error: err.message }, err.status);
      }
      throw err;
    }
  }
  if (req.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }
  switch (url.pathname) {
    case "/api/snapshot":
      return json(snapshot(deps));
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
}

export function serve(
  deps: WebDeps,
  listen: { hostname: string; port: number },
  page: HTMLBundle,
) {
  const server = Bun.serve({
    hostname: listen.hostname,
    port: listen.port,
    // no HMR endpoint or dev error pages in production; `bun --watch`
    // restarts the process for the dev loop
    development: false,
    routes: { "/": page },
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/ws") {
        if (!sameOrigin(req)) {
          return new Response("cross-origin request", { status: 403 });
        }
        return srv.upgrade(req)
          ? undefined
          : new Response("websocket upgrade failed", { status: 400 });
      }
      return handle(req, deps);
    },
    websocket: {
      open(ws) {
        ws.subscribe(SAMPLES_TOPIC);
        const msg: WsMessage = { type: "snapshot", data: snapshot(deps) };
        ws.send(JSON.stringify(msg));
      },
      message() {
        // the client sends nothing yet
      },
      close(ws) {
        ws.unsubscribe(SAMPLES_TOPIC);
      },
    },
  });
  // One serialisation per tick regardless of tab count; Bun fans it out.
  const publish = (msg: WsMessage) =>
    server.publish(SAMPLES_TOPIC, JSON.stringify(msg));
  const unsubscribe = deps.sampler.onSample((sample) =>
    publish({ type: "sample", data: sample }),
  );
  const unsubscribeEvents = deps.actions.onEvent((event) =>
    publish({ type: "event", data: event }),
  );
  return {
    server,
    stop() {
      unsubscribe();
      unsubscribeEvents();
      server.stop(true);
    },
  };
}
