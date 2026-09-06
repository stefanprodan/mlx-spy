// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// HTTP API and WebSocket push over the sampler and history. The page itself
// is an HTML import bundled by Bun (passed in from main.ts so this module
// stays importable from tests without the bundler); actions arrive in the
// next milestone.

import { networkInterfaces } from "node:os";
import type { HTMLBundle } from "bun";
import type { Engine } from "./engine/types.ts";
import { type History, RANGES, type Range } from "./history.ts";
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
  version: string;
  local: boolean;
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
    },
    sample: deps.history.latest(),
    models: deps.sampler.currentModels(),
    disk: deps.sampler.currentDisk(),
  };
}

// What a tab receives on connect, then one "sample" message per tick.
export type WsMessage =
  | { type: "snapshot"; data: ReturnType<typeof snapshot> }
  | { type: "sample"; data: Sample };

// Route handler, separate from Bun.serve so tests can call it with a Request.
export function handle(req: Request, deps: WebDeps): Response {
  const url = new URL(req.url);
  if (req.method !== "GET") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  switch (url.pathname) {
    case "/api/snapshot":
      return Response.json(snapshot(deps));
    case "/api/history": {
      const range = url.searchParams.get("range") ?? "1h";
      if (!isRange(range)) {
        return Response.json(
          { error: `range must be one of ${Object.keys(RANGES).join(", ")}` },
          { status: 400 },
        );
      }
      return Response.json({
        range,
        series: deps.history.series(range, (deps.now ?? Date.now)()),
      });
    }
    default:
      return Response.json({ error: "not found" }, { status: 404 });
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
  const unsubscribe = deps.sampler.onSample((sample) => {
    const msg: WsMessage = { type: "sample", data: sample };
    server.publish(SAMPLES_TOPIC, JSON.stringify(msg));
  });
  return {
    server,
    stop() {
      unsubscribe();
      server.stop(true);
    },
  };
}
