# AGENTS.md

Guidance for AI agents and contributors working on **mlx-spy**, a monitor and
control panel for LLM inference servers on Apple Silicon (mlx-serve first).

## What this is

A single Bun/TypeScript program that runs next to an inference engine, samples
the engine and the host once a second, keeps history, and serves a dashboard
with the control actions the engine's own console lacks (unload, load as
default, free RAM, clear the disk cache). The plan lives in `plans/`; the
milestone list there is the roadmap.

- **Runtime:** Bun only (TypeScript run directly, no build step for dev). No
  Node.
- **Platforms:** macOS on Apple Silicon. Host probes use `bun:ffi` against
  libproc and Mach, as cctop does.
- **Zero runtime dependencies.** `package.json` has no `dependencies` field.
  The one planned exception is uPlot, pinned exactly, embedded at build time
  as a devDependency so the binary and the page load nothing remote. Do not
  add other packages.

## Rules that protect the engine

1. **Never call `GET /props` on mlx-serve.** It goes through the model-load
   path and cold-loads the default model. That poll in the engine's own web
   console undoes API unloads, evicts the model a client just loaded, and
   halves decode speed while it fights a running request. The adapter uses
   only endpoints answered before the load step: `/health`, `/metrics.json`,
   `/v1/models`. Anything new must be verified the same way in mlx-serve's
   `src/server.zig` before use.
2. **The sampler is read-only.** `load`, `unload`, `restart` and `diskClear`
   run only from an explicit user action through the actions layer, are
   logged, and are disabled when the engine URL is not local.
3. **Spawn exceptions.** The monitor path spawns no processes: host numbers
   come from FFI, directory sizes from recursive stat. The only spawns are the
   two local-only actions: `launchctl kickstart -k gui/<uid>/<label>` for
   "free" and the deletion of the disk cache contents for "disk clear". The
   cache path comes from the adapter's allow-list, never from the request.
4. **Fail fast on the engine.** Sampler requests time out in 3 s and a failed
   read produces a sample with `engineUp: false`; never let a hung engine
   stall the loop.

## Commands

Use the Makefile; each target runs the `package.json` script of the same
name, so `make <x>` and `bun run <x>` are interchangeable. (`install-bin` is
named to match its script: a script plainly named `install` would fire on
`bun install`.)

```sh
make start ARGS="--engine http://127.0.0.1:11234 --once"   # one JSON sample
make dev ARGS="..."   # --watch live reload
make lint             # bun biome check --write . && bun tsc --noEmit
make test             # bun test
make build            # compile a standalone binary into bin/
make clean            # remove bin/ and stray .bun-build files
make install-bin      # compile + install onto PATH (override PREFIX=...)
```

**Always run `make lint` before finishing a change** (format, lint,
type-check) and **`make test`** when you touch the adapter or sampler.
`make lint` does not run the tests.

## Layout

```
src/main.ts          entry: CLI parsing, --once (one JSON sample), -h, -v;
                     VERSION derived from package.json
src/engine/types.ts  the Engine interface and the normalised metric types;
                     adapters translate their server's names into these
src/engine/mlxserve.ts
                     mlx-serve adapter: parseMetrics/parseModels (pure, tested),
                     the HTTP client, load/unload, cache dir and log paths
src/sample.ts        Sample type; computeRates (windowed tok/s, cache ratios,
                     epoch detection on counter reset) and buildSample are pure
                     and tested; takeSample does the I/O for --once
test/                bun test suites; fixtures/ holds /metrics.json and
                     /v1/models bodies recorded from the live engine
plans/               the development plan and milestones
```

Data flow: adapter (`/metrics.json`, `/v1/models`) → `Reading` → `computeRates`
over the previous reading → `buildSample` → JSON on stdout (milestone 1); the
1 Hz loop, history and web layers land in later milestones.

## mlx-serve specifics worth knowing

- Model ids are `<org>/<name>` in serve mode; the API and OpenCode use the
  full id.
- `generation_tokens_live` and `prefill_tokens_live` hold the token count of
  the current request and drop back when a new one starts, so a negative
  delta means "new request", not a reset. Counters (`*_total`) only go
  backwards on a process restart; that bumps the epoch.
- `memory_mb` is the process footprint; `mlx_active_bytes` is the MLX
  allocator (weights plus KV); `mlx_cache_bytes` is MLX's reclaimable pool,
  not the prefix cache. The hot prefix cache has no gauge, so it is estimated
  as active minus the loaded models' `bytes_resident` and labelled as such.
- mlx-serve does not say which model is the default; `isDefault` stays
  undefined for it.
- Disk tier at `~/.mlx-serve/kv-cache/<fingerprint>/`; server log at
  `~/.mlx-serve/logs/mlx-serve-<port>.log`.

## Conventions

- **Style is enforced by Biome** (`biome.json`): 2-space indent, double
  quotes, semicolons, trailing commas, 80 columns. `noExplicitAny` is off
  for FFI and JSON parsing, `noNonNullAssertion` is off.
- **Types** are checked by `bun tsc --noEmit` as part of `make lint`.
- **Comments explain why, not what.** The engine caveats above are
  load-bearing where they appear in code; keep them.
- **Version is single-sourced** in `package.json`; `src/main.ts` derives
  `VERSION`. Bump via `bun pm version`.
- **Pure logic separate from I/O.** Parsers and rate math take plain data and
  are tested on recorded fixtures; fetches and sleeps live in thin wrappers.
- No em-dashes in prose or docs. `perl -i -pe` for global replaces, not sed.
  `uv` for ad hoc Python, never pip. No `Co-authored-by` or session trailers
  in commits or PRs. npm packages official only, exact pins,
  `bun install --ignore-scripts`, 24 h cooldown on new releases.

## Verifying changes

- `make lint`, `make test`.
- Against a live engine over the tailnet (no ssh needed):
  `bun src/main.ts --engine http://<studio>:11234 --once`. Exit code 0 when
  the engine answered, 2 when it did not (`engineUp: false`), 1 on bad
  arguments.
- Record new fixtures with `curl <engine>/metrics.json` and
  `curl <engine>/v1/models`, pretty-printed, into `test/fixtures/`. Never
  record `/props`.
