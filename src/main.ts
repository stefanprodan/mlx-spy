#!/usr/bin/env bun

// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// mlx-spy - monitoring and control for LLM inference servers on Apple
// Silicon. Samples an engine (mlx-serve first) and the host once a second,
// keeps history, and serves a dashboard with the control actions the engine's
// own console lacks.
//
// `--once` prints a single JSON sample and exits; otherwise the sampler runs
// at 1 Hz, writes history to SQLite and serves the API.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../package.json";
import { MlxServe } from "./engine/mlxserve.ts";
import { History } from "./history.ts";
import { createHostProbes } from "./host/index.ts";
import { isLocalUrl } from "./host/local.ts";
import { takeSample } from "./sample.ts";
import { Sampler } from "./sampler.ts";
import page from "./ui/index.html";
import { DEFAULT_PORT, serve, tailscaleAddress } from "./web.ts";

export const VERSION = `v${pkg.version}`;

const DEFAULT_ENGINE = "http://127.0.0.1:11234";
const DEFAULT_DB = join(homedir(), ".mlx-spy", "history.sqlite");
const DEFAULT_RETENTION_DAYS = 7;
// Rates need two readings; one second matches the sampler's tick.
const ONCE_WINDOW_MS = 1000;

const HELP = `\x1b[1mmlx-spy\x1b[0m - monitor and control an LLM inference server

\x1b[1mUsage:\x1b[0m
  mlx-spy [options]

\x1b[1mOptions:\x1b[0m
  --engine <url>       engine base URL (default: ${DEFAULT_ENGINE})
  --listen <host:port> bind address (default: the Tailscale address, else
                       127.0.0.1, port ${DEFAULT_PORT})
  --db <path>          SQLite history file (default: ~/.mlx-spy/history.sqlite;
                       ":memory:" keeps nothing)
  --retention <days>   history retention (default: ${DEFAULT_RETENTION_DAYS})
  --once               print one JSON sample and exit
  -v, --version        show version
  -h, --help           show this help

\x1b[1mAPI:\x1b[0m
  GET /                        the dashboard
  GET /api/snapshot            latest sample and model list
  GET /api/history?range=1h    series for 1h, 6h, 24h or 7d
  WS  /ws                      snapshot on connect, then one sample per second

\x1b[1mExamples:\x1b[0m
  mlx-spy --engine http://127.0.0.1:11234 --once
  mlx-spy --engine http://studio.tailnet:11234 --listen 127.0.0.1:11235`;

function fail(message: string): never {
  console.error(`error: ${message}\n\n${HELP}`);
  process.exit(1);
}

let engineUrl = DEFAULT_ENGINE;
let listen: string | null = null;
let dbPath = DEFAULT_DB;
let retentionDays = DEFAULT_RETENTION_DAYS;
let once = false;
const args = Bun.argv.slice(2);

// --flag value and --flag=value both work
function value(i: number): [string, number] {
  const arg = args[i];
  const eq = arg.indexOf("=");
  if (eq !== -1) return [arg.slice(eq + 1), i];
  const v = args[i + 1];
  if (v === undefined) fail(`${arg} needs a value`);
  return [v, i + 1];
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const name = arg.split("=")[0];
  if (arg === "-h" || arg === "--help") {
    console.log(HELP);
    process.exit(0);
  } else if (arg === "-v" || arg === "--version") {
    console.log(VERSION);
    process.exit(0);
  } else if (arg === "--once") {
    once = true;
  } else if (name === "--engine") {
    [engineUrl, i] = value(i);
  } else if (name === "--listen") {
    [listen, i] = value(i);
  } else if (name === "--db") {
    [dbPath, i] = value(i);
  } else if (name === "--retention") {
    const [v, j] = value(i);
    i = j;
    retentionDays = Number(v);
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      fail(`--retention must be a positive number of days: ${v}`);
    }
  } else {
    fail(`unknown argument: ${arg}`);
  }
}

try {
  new URL(engineUrl);
} catch {
  fail(`invalid engine URL: ${engineUrl}`);
}

const engine = new MlxServe(engineUrl);
const probes = await createHostProbes();
const local = isLocalUrl(engineUrl);

if (once) {
  const sample = await takeSample(engine, ONCE_WINDOW_MS, probes);
  console.log(JSON.stringify(sample, null, 2));
  process.exit(sample.engineUp ? 0 : 2);
}

let hostname = tailscaleAddress() ?? "127.0.0.1";
let port = DEFAULT_PORT;
if (listen) {
  const m = /^(.*?)(?::(\d+))?$/.exec(listen);
  if (!m) fail(`invalid --listen: ${listen}`);
  if (m[1]) hostname = m[1];
  if (m[2]) port = Number(m[2]);
}

const log = (line: string) =>
  console.error(`${new Date().toISOString()} ${line}`);

if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const history = new History(dbPath, retentionDays);
const sampler = new Sampler(engine, history, { log, probes, local });
const web = serve(
  { engine, sampler, history, version: VERSION, local },
  { hostname, port },
  page,
);
sampler.start();
log(
  `mlx-spy ${VERSION} on http://${web.server.hostname}:${web.server.port}, engine ${engineUrl} (${local ? "local" : "remote"}), history ${dbPath}`,
);

const shutdown = () => {
  sampler.stop();
  web.stop();
  history.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
