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
import { dirname, join, resolve } from "node:path";
import pkg from "../package.json";
import { Actions } from "./actions.ts";
import { ChatRunner } from "./chat.ts";
import { ChatStore } from "./chats.ts";
import { ConfigStore } from "./config.ts";
import { MlxServe, mlxServeProvider, parseSize } from "./engine/mlxserve.ts";
import {
  Catalog,
  DEFAULT_LIMIT as OPENROUTER_LIMIT,
  OpenRouter,
} from "./engine/openrouter.ts";
import { History } from "./history.ts";
import { createHostProbes } from "./host/index.ts";
import { hostInfo } from "./host/info.ts";
import { isLocalUrl } from "./host/local.ts";
import { PullRunner } from "./pull.ts";
import { PullStore } from "./pulls.ts";
import { takeSample } from "./sample.ts";
import { Sampler } from "./sampler.ts";
import type { SearchKeys } from "./tools/search/types.ts";
import { loadKey, loadSearchKeys, secretsDir } from "./tools/websearch.ts";
import { TOOLS } from "./tools.ts";
import page from "./ui/index.html";
import { DEFAULT_PORT, serve, tailscaleAddress } from "./web.ts";

const buildVersion = process.env.MLX_SPY_BUILD_VERSION;
export const VERSION = buildVersion || `v${pkg.version}`;

const DEFAULT_ENGINE = "http://127.0.0.1:11234";
const DEFAULT_DB = join(homedir(), ".mlx-spy", "history.sqlite");
const DEFAULT_MODEL_DIR = join(homedir(), ".mlx-spy", "models");
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
  --model-dir <path>   where downloads from the Hugging Face Hub land, as
                       <owner>/<name> directories (default: ~/.mlx-spy/models;
                       point it at the engine's model directory)
  --hot-cache-max <n>  hot cache budget per model, e.g. 16GB (default: read
                       from the engine's launchd plist when local)
  --disk-cache-max <n> SSD cache tier budget per model, e.g. 50GB (same)
  --openrouter-concurrency <n>
                       chats answered by OpenRouter at once (default:
                       ${OPENROUTER_LIMIT}; the engine takes one)
  --once               print one JSON sample and exit
  -v, --version        show version
  -h, --help           show this help
  Keys: ../secrets/{exa,firecrawl,hf,openrouter}.key next to the binary
                       (.preview/secrets/ from source); search is keyless,
                       the Hub anonymous and OpenRouter absent from the
                       chat when the file is missing; read at start

\x1b[1mAPI:\x1b[0m
  GET /                        the dashboard
  GET /requests                finished and in-flight engine requests
  GET /chat[/<id>]             persistent chats
  GET|POST /api/chats          list or create chats
  GET|PATCH|DELETE /api/chats/<id>
                               read, update or delete a chat
  POST /api/chats/<id>/<name>  messages, regenerate, edit or stop
  GET /api/tools                available chat tools
  GET /api/config               the hosted models added from the chat's
                               Settings page; POST .../openrouter/refresh,
                               check, models and DELETE .../models/<id>
  GET|POST /api/pulls          list downloads or start one (body {"repo"})
  GET|DELETE /api/pulls/<id>   read or forget a download
  POST /api/pulls/<id>/cancel  stop a download; its parts are kept
  GET /api/snapshot            latest sample and model list
  GET /api/history?range=1h    series for 1h, 6h, 24h or 7d
  WS  /ws                      snapshot on connect, then one sample per second
  POST /api/actions/<name>     load, unload, default (body {"model"}), free,
                               diskClear (the last two only for a local engine),
                               historyClear (wipes the sample database),
                               requestsClear (wipes the stored requests),
                               favorite (toggles the daily-driver star)

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
let modelDir = DEFAULT_MODEL_DIR;
let retentionDays = DEFAULT_RETENTION_DAYS;
let once = false;
let hotMax: number | null = null;
let diskMax: number | null = null;
let openRouterLimit = OPENROUTER_LIMIT;
const args = Bun.argv.slice(2);

// --flag value and --flag=value both work
function value(i: number): [string, number] {
  const arg = args[i];
  const eq = arg.indexOf("=");
  if (eq !== -1) return [arg.slice(eq + 1), i];
  const v = args[i + 1];
  // the next flag is not this one's value: `--db --once` is a mistake, and
  // a value that really starts with a dash is written --flag=value
  if (v === undefined || v.startsWith("-")) fail(`${arg} needs a value`);
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
  } else if (name === "--model-dir") {
    [modelDir, i] = value(i);
    if (modelDir === "") fail("--model-dir must not be empty");
    modelDir = resolve(modelDir);
  } else if (name === "--retention") {
    const [v, j] = value(i);
    i = j;
    retentionDays = Number(v);
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      fail(`--retention must be a positive number of days: ${v}`);
    }
  } else if (name === "--hot-cache-max" || name === "--disk-cache-max") {
    const [v, j] = value(i);
    i = j;
    const bytes = parseSize(v);
    if (bytes === null) fail(`${name} expects <n>{KB,MB,GB} or off: ${v}`);
    if (name === "--hot-cache-max") hotMax = bytes;
    else diskMax = bytes;
  } else if (name === "--openrouter-concurrency") {
    const [v, j] = value(i);
    i = j;
    openRouterLimit = Number(v);
    if (!Number.isSafeInteger(openRouterLimit) || openRouterLimit < 1) {
      fail(`--openrouter-concurrency must be a positive integer: ${v}`);
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
// per-model budgets: the launch flags when the engine is local, else only
// what the user tells us; a flag overrides the plist either way
const plistLimits = local ? await engine.cacheLimits() : null;
const limits =
  hotMax !== null || diskMax !== null || plistLimits
    ? {
        hotBytes: hotMax ?? plistLimits?.hotBytes ?? 0,
        diskBytes: diskMax ?? plistLimits?.diskBytes ?? 0,
      }
    : null;

if (once) {
  const sample = await takeSample(engine, ONCE_WINDOW_MS, probes);
  console.log(JSON.stringify(sample, null, 2));
  process.exit(sample.engineUp ? 0 : 2);
}

let hostname = tailscaleAddress() ?? "127.0.0.1";
let port = DEFAULT_PORT;
if (listen) {
  // host, :port, host:port or [v6]:port
  const m = /^(?:\[([^\]]+)\]|([^:]*))(?::(\d+))?$/.exec(listen);
  if (!m) fail(`invalid --listen: ${listen}`);
  const host = m[1] ?? m[2];
  if (host) hostname = host;
  if (m[3] !== undefined) {
    port = Number(m[3]);
    if (port < 1 || port > 65535) fail(`invalid --listen port: ${m[3]}`);
  }
}

const log = (line: string) =>
  console.error(`${new Date().toISOString()} ${line}`);

// a bad key file fails loud and plain, without the help text: the path in
// the message is what the user needs
const searchDir = secretsDir();
let searchKeys: SearchKeys;
let hubToken: string | null;
let openRouterKey: string | null;
try {
  searchKeys = loadSearchKeys(searchDir);
  hubToken = loadKey(join(searchDir, "hf.key"));
  openRouterKey = loadKey(join(searchDir, "openrouter.key"));
} catch (error) {
  console.error(
    `error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
log(
  `exa key: ${searchKeys.exa === null ? "none" : join(searchDir, "exa.key")}`,
);
log(
  `firecrawl key: ${
    searchKeys.firecrawl === null ? "none" : join(searchDir, "firecrawl.key")
  }`,
);
log(`hf key: ${hubToken === null ? "none" : join(searchDir, "hf.key")}`);
log(
  `openrouter key: ${
    openRouterKey === null ? "none" : join(searchDir, "openrouter.key")
  }`,
);

if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const history = new History(dbPath, retentionDays);
const chats = new ChatStore(
  history.db,
  Date.now,
  () => TOOLS.map((tool) => tool.name),
  log,
);
const repaired = chats.repairInterrupted();
if (repaired > 0) {
  log(
    `chat repaired ${repaired} interrupted repl${repaired === 1 ? "y" : "ies"}`,
  );
}
const sampler = new Sampler(engine, history, { log, probes, local });
const actions = new Actions({ engine, sampler, history, local, log });
const config = new ConfigStore(history.db);
// OpenRouter is a chat provider only when its key is on disk; its saved
// models are refreshed from the public catalog once at start (a miss keeps
// their stored prices) and again whenever the config page opens
const catalog = openRouterKey === null ? null : new Catalog();
const openRouter =
  openRouterKey === null
    ? null
    : new OpenRouter({
        key: openRouterKey,
        models: () => config.list("openrouter"),
        limit: openRouterLimit,
      });
if (catalog) {
  const saved = config.list("openrouter").length;
  log(`openrouter models: ${saved} listed, ${openRouterLimit} at once`);
  void catalog
    .get(true)
    .then((models) => {
      const found = config.refresh("openrouter", models);
      if (found < saved) {
        log(`openrouter catalog: ${saved - found} listed models not in it`);
      }
    })
    .catch((err) =>
      log(`openrouter catalog: ${err instanceof Error ? err.message : err}`),
    );
}
const chat = new ChatRunner({
  engine,
  providers: {
    mlxserve: mlxServeProvider(engine, () => sampler.currentModels()),
    openrouter: openRouter,
  },
  store: chats,
  log,
  version: VERSION,
  searchKeys,
});
const pulls = new PullRunner({
  store: new PullStore(history.db),
  modelDir,
  token: hubToken,
  engine,
  refreshModels: () => sampler.refreshModels(),
  log,
});
const web = serve(
  {
    engine,
    sampler,
    history,
    actions,
    chat,
    pulls,
    version: VERSION,
    local,
    limits,
    host: await hostInfo(),
    modelDir,
    config,
    catalog,
  },
  { hostname, port },
  page,
);
sampler.start();
pulls.resume();
log(
  `mlx-spy ${VERSION} on http://${web.server.hostname}:${web.server.port}, engine ${engineUrl} (${local ? "local" : "remote"}), history ${dbPath}, models ${modelDir}`,
);

const shutdown = () => {
  sampler.stop();
  chat.shutdown();
  pulls.shutdown();
  web.stop();
  history.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
