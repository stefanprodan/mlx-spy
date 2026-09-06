// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// HTTP API over the sampler and history. The page, the WebSocket push and
// the actions arrive in later milestones; this file is the place they land.

import { networkInterfaces } from "node:os";
import type { Engine } from "./engine/types.ts";
import { type History, RANGES, type Range } from "./history.ts";
import type { Sampler } from "./sampler.ts";

export const DEFAULT_PORT = 11235;

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
  // injectable for tests; the history range is relative to it
  now?: () => number;
};

export function snapshot(deps: WebDeps) {
  return {
    version: deps.version,
    engine: { id: deps.engine.id, url: deps.engine.url },
    sample: deps.history.latest(),
    models: deps.sampler.currentModels(),
  };
}

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
) {
  return Bun.serve({
    hostname: listen.hostname,
    port: listen.port,
    fetch: (req) => handle(req, deps),
  });
}
