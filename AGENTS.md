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
  The one exception is uPlot (`uplot.6.32`, exact pin, a devDependency):
  Bun bundles it into the page at build time, so the binary and the page
  load nothing remote. Do not add other packages.

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
   logged, and are disabled when the engine URL is not local. The chat
   runner is the only other engine caller: it posts to
   `/v1/chat/completions` (always streaming, so the engine cancels the
   slot when mlx-spy aborts the request) only when a user sends a message,
   and a message naming a non-resident model cold-loads it on purpose.
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
src/main.ts          entry: CLI parsing (--engine, --listen, --db, --retention,
                     --hot-cache-max, --disk-cache-max, --once, -h, -v); wires sampler, history and server;
                     VERSION derived from package.json
src/engine/types.ts  the Engine interface and the normalised metric types;
                     adapters translate their server's names into these
src/engine/mlxserve.ts
                     mlx-serve adapter: parseMetrics/parseModels (pure, tested),
                     the HTTP client, load/unload, cache dir and log paths,
                     cacheLimits() from the LaunchAgent plist (pure parsers
                     parseSize/parseLaunchdArgs/limitsFromArgs, tested)
src/sample.ts        Sample type; computeRates (tok/s between live gauge moves, cache ratios,
                     epoch detection on counter reset) and buildSample are pure
                     and tested; takeSample does the I/O for --once
src/requests.ts      trackRequests: the engine-wide request in flight (start of
                     the oldest open one, time spent prefilling and decoding)
                     and the last finished one from the counter deltas at the
                     tick the decode-time histogram advanced; pure, tested
src/sampler.ts       the 1 Hz loop: reads metrics each tick, models every 5 s,
                     carries epoch, last counters and the last request across
                     restarts through the history meta table; tick() is
                     public for tests
src/history.ts       ring buffer (1 h) plus bun:sqlite: samples table, 7 day
                     retention pruned from the writer, bucketed series() per
                     range in columnar form for uPlot; models table (ids the
                     engine lists, the user's favorite flag; synced each fetch);
                     requests table (the last 50 finished or cancelled
                     requests as the tracker saw them, plus the resident
                     model, the favorite among several)
src/chats.ts         ChatStore over the same bun:sqlite file: chats (settings
                     live on the chat) and messages (status done, streaming,
                     stopped, interrupted, error; the reply's stats from the
                     usage chunk); streaming rows become interrupted at boot
src/chat.ts          ChatRunner: owns the one generation in flight (the
                     browser never talks to the engine), writes the partial
                     reply every 250 ms or 2 KB, publishes offset-tagged
                     deltas and server-rendered HTML on /ws, stop from any
                     tab, regenerate, edit, shutdown marks the row interrupted
src/markdown.ts      renderMarkdown(): Bun.markdown.render() with a full
                     callback set, the safety boundary for model output
                     (raw HTML as text, http/https/mailto links only, no img)
src/actions.ts       the control actions: load (as the engine default),
                     unload (hands the default to a model still resident,
                     the favorite first) and default through the
                     adapter, free (launchctl kickstart -k of the service
                     label), diskClear (restart, then delete the children
                     of the adapter's cache dirs), local-only, and
                     historyClear (wipes the sample table) and favorite (the
                     daily-driver toggle, mlx-spy's own); validates the
                     model id against the current list, one action at a time,
                     logs every outcome, keeps the last 50 events; spawn and
                     directory wipe are injectable for tests
src/web.ts           Bun.serve: the page (HTML import passed in from main.ts),
                     /api/snapshot, /api/history?range=, /api/requests,
                     POST /api/actions/
                     <name>, /api/chats and its sub-routes, /ws (snapshot on
                     connect, then pub/sub of one sample per tick, one event
                     per finished action and the chat events);
                     handle() is separate from serve() so tests call it with
                     a Request; tailscaleAddress() picks the default bind
src/ui/index.html    the dashboard, one bundle for three paths: / (monitor),
                     /requests (the live bar moved over, then the stored
                     list) and /chat, /chat/<id> (the chat frame); tile row, five uPlot charts, models table
                     with load/unload/default buttons, Restart engine and Clear
                     disk cache in the section head, a confirm dialog;
                     Bun bundles style.css and app.ts from it (also into the
                     compiled binary, Bun 1.2.17+)
src/ui/app.ts        browser client: WebSocket, tiles, uPlot charts with a
                     shared cursor, range picker (1h raw and live-appended,
                     longer ranges bucketed and re-fetched every minute);
                     hands the chat view its snapshot, samples and events
src/ui/chat.ts       the Chat view: list, transcript, composer; applies
                     deltas by offset so a reload or a second tab resumes a
                     streaming reply from the row in the DB; shows the
                     server's HTML plus a plain-text tail while streaming
src/ui/style.css     follows the engine's own console (its tokens: #131314 page,
                     #1e1f20 cards, #0f1216 inset tiles, 10px uppercase labels,
                     26px bold mono values); single-series sparklines use the
                     console's green and blue. uPlot's legend is hidden; each
                     box shows its values in the head (latest, or at the
                     shared cursor)
src/host/index.ts    probe facade: darwin FFI on macOS, NULL_PROBES elsewhere
src/host/info.ts     hostInfo(): static host facts for the Runtime section (macOS
                     version from SystemVersion.plist, chip and cores from
                     sysctl, GPU cores from the IORegistry, home volume via
                     statfs); read once at startup, disk space per snapshot
src/host/darwin.ts   bun:ffi: host_statistics64 (host memory), proc_pid_rusage
                     (engine footprint, RSS, CPU time), proc_pidinfo (start
                     time), proc_listallpids + proc_pidpath (pid by executable
                     basename), darwinHostInfo() (chip, cores, GPU cores). Offsets verified with
                     offsetof(); load-bearing comments
src/host/disk.ts     cacheDirSizes(): one entry per child dir of each cache
                     root, allocated bytes like du, async, no spawn
src/host/local.ts    isLocalUrl(): is the engine on this host (loopback, own
                     interface address or host name); gates the pid probe,
                     the disk walk and later the local-only actions
src/host/types.ts    HostProbes, HostMemory, ProcessMemory, DiskDir, HostSnapshot
test/                bun test suites; fixtures/ holds /metrics.json and
                     /v1/models bodies recorded from the live engine
docs/                user docs: monitor, chat, api, development (keep the
                     API page in step with web.ts)
plans/               the development plan and milestones
```

Data flow: adapter (`/metrics.json`, `/v1/models`) → `Reading` → `computeRates`
over the previous reading, joined with the host probes (memory every tick,
pid rescanned every 5 s when unknown, disk tier every 30 s) → `buildSample` →
History (ring + SQLite) and
listeners → `/api/snapshot`, `/api/history` and the `/ws` push → the page.
`--once` short-circuits to a single sample on stdout. Actions go the other
way: a button → confirm dialog → `POST /api/actions/<name>` → `Actions.run`
(guards, adapter call or spawn, model refresh, log) → an event on `/ws` that
every tab shows under the models table. A chat message: composer →
`POST /api/chats/<id>/messages` → `ChatRunner.send` (rows inserted with
status streaming, `engine.chat()` streamed, the row written as it grows)
→ `{type: "chat"}` events on `/ws` in every tab → `done` with the final row
and its stats. A tab that opens mid-answer fetches the chat and applies
only the deltas whose offset continues the text it has.

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
  `~/.mlx-serve/logs/mlx-serve-<port>.log`. The service label is
  `com.ddalcu.mlx-serve` (the adapter's `serviceLabel()`); "free" is a
  `launchctl kickstart -k gui/<uid>/<label>` because a fresh process has no
  default model and so nothing to cold-load.
- `--prefix-cache-mem` and `--prefix-cache-disk` are per resident model
  (each load builds its own HotPrefixCache and DiskTier with the flag as
  budget, `scheduler.zig`, verified 2026-09-07 at 0897f01) and the hot one
  is clamped against headroom at load. No endpoint reports them, so the
  adapter reads the plist's ProgramArguments; the tiles multiply the budget
  by the resident model count (hot) and the tier dir count (SSD).
- The engine's `memory_mb` matches libproc's `ri_phys_footprint` (41.36 GB
  both, measured 2026-09-07), so the remote dev loop shows the same footprint
  number as the Studio; only RSS and the pid need the probe to be local.
- Host memory on macOS: `free` is small by design; free + inactive is the
  practical headroom (what `mlxctl status` prints). `compressed` is the
  compressor's page count.


## Conventions

- **Style is enforced by Biome** (`biome.json`): 2-space indent, double
  quotes, semicolons, trailing commas, 80 columns. `noExplicitAny` is off
  for FFI and JSON parsing, `noNonNullAssertion` is off.
- **Types** are checked by `bun tsc --noEmit` as part of `make lint`. The
  browser client shares the tsconfig (lib includes DOM); `src/ui/env.d.ts`
  declares the CSS side-effect import.
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
- The page: run against the Studio with `--listen 127.0.0.1:11299 --db
  :memory:` (the chat needs a file db to survive a restart; use a scratch
  path), open it in Chrome (the DevTools MCP works for screenshots and
  the console), check the console is empty and the range picker switches.
  The bundle is built at startup with `development: false`, so restart the
  process after a UI change (`bun --watch` does that).
- Against a live engine over the tailnet (no ssh needed):
  `bun src/main.ts --engine http://<studio>:11234 --once`. Exit code 0 when
  the engine answered, 2 when it did not (`engineUp: false`), 1 on bad
  arguments. From the MacBook the engine is remote: `enginePid` is null,
  `procRss` 0 and `disk` empty by design; host memory is the MacBook's.
- The full picture needs the binary on the Studio: `make build`, scp it to
  `/tmp`, run `--once --engine http://127.0.0.1:11234` over ssh, remove it.
  Read the homelab `studio-ops.md` rules before any ssh command.
- Record new fixtures with `curl <engine>/metrics.json` and
  `curl <engine>/v1/models`, pretty-printed, into `test/fixtures/`. Never
  record `/props`.
