#!/usr/bin/env bun

// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// mlx-spy - monitoring and control for LLM inference servers on Apple
// Silicon. Samples an engine (mlx-serve first) and the host once a second,
// keeps history, and serves a dashboard with the control actions the engine's
// own console lacks.
//
// Milestone 1: `--once` prints a single JSON sample and exits. The 1 Hz
// sampler, history and web UI follow (see plans/).

import pkg from "../package.json";
import { MlxServe } from "./engine/mlxserve.ts";
import { takeSample } from "./sample.ts";

export const VERSION = `v${pkg.version}`;

const DEFAULT_ENGINE = "http://127.0.0.1:11234";
// Rates need two readings; one second matches the sampler's tick.
const ONCE_WINDOW_MS = 1000;

const HELP = `\x1b[1mmlx-spy\x1b[0m - monitor and control an LLM inference server

\x1b[1mUsage:\x1b[0m
  mlx-spy [options]

\x1b[1mOptions:\x1b[0m
  --engine <url>   engine base URL (default: ${DEFAULT_ENGINE})
  --once           print one JSON sample and exit
  -v, --version    show version
  -h, --help       show this help

\x1b[1mExamples:\x1b[0m
  mlx-spy --engine http://127.0.0.1:11234 --once
  mlx-spy --engine http://studio.tailnet:11234 --once | jq .mem`;

function fail(message: string): never {
  console.error(`error: ${message}\n\n${HELP}`);
  process.exit(1);
}

let engineUrl = DEFAULT_ENGINE;
let once = false;
const args = Bun.argv.slice(2);

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-h" || arg === "--help") {
    console.log(HELP);
    process.exit(0);
  } else if (arg === "-v" || arg === "--version") {
    console.log(VERSION);
    process.exit(0);
  } else if (arg === "--once") {
    once = true;
  } else if (arg === "--engine") {
    const v = args[++i];
    if (!v) fail("--engine needs a URL");
    engineUrl = v;
  } else if (arg.startsWith("--engine=")) {
    engineUrl = arg.slice("--engine=".length);
  } else {
    fail(`unknown argument: ${arg}`);
  }
}

try {
  new URL(engineUrl);
} catch {
  fail(`invalid engine URL: ${engineUrl}`);
}

if (!once) fail("only --once is implemented yet (server mode comes next)");

const engine = new MlxServe(engineUrl);
const sample = await takeSample(engine, ONCE_WINDOW_MS);
console.log(JSON.stringify(sample, null, 2));
process.exit(sample.engineUp ? 0 : 2);
