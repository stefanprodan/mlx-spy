# AGENTS.md

How to work on **mlx-spy**, a monitor and control panel for LLM inference
servers on Apple Silicon (mlx-serve first). One Bun/TypeScript program
samples the engine and the host once a second, keeps history, and serves a
dashboard with the control actions the engine's own console lacks, plus a
chat that streams through mlx-spy so replies survive the tab.

- **Runtime:** Bun only, TypeScript run directly. No Node.
- **Platform:** macOS on Apple Silicon. Host probes use `bun:ffi`.
- **Zero runtime dependencies.** The devDependencies bundled into the page
  at build time are uPlot, Preact, `@preact/signals` and
  `preact-render-to-string` (tests only), exact pins. Do not add packages.
- The roadmap is in `plans/`.

## The dev loop

Everything goes through the Makefile; each target runs the `package.json`
script of the same name.

```sh
make preview        # (re)start the local preview, detached, hot reload
make preview-stop   # stop it
make preview-log    # tail its log
make preview-clean  # stop it and wipe its db, log and pid (make clean does too)
make lint           # biome check --write, then tsc
make test           # bun test; both run after any code change, before finishing
make build          # standalone binary in bin/
make deploy-studio  # build, install and restart on the Mac Studio
```

### Seeing a change

1. `scripts/preview.sh status`. If it is not up, `make preview`. It runs
   the source against the Studio's engine (named in `scripts/studio.env`,
   git-ignored) on `http://127.0.0.1:11236`, with its pid, db and log
   under `.preview/`. Never start the server by hand in the background.
2. Edit. The preview runs with `MLX_SPY_DEV=1`, which turns on Bun's dev
   server: an edit to `src/ui/style.css` hot-reloads in the open tab, an
   edit to a `.ts` or `.tsx` file under `src/ui/` reloads the page (Bun
   has no fast refresh for Preact; the state comes back from the server);
   server-side TypeScript restarts the process through `bun --watch`.
   The one exception: an edit to `index.html` can leave the dev server
   with "Failed to load bundled module" in the page; `make preview`
   clears it.
3. Look at it. Open `http://127.0.0.1:11236/`, `/requests` and `/chat` in
   Chrome through the DevTools MCP: screenshot at a desktop width (1400)
   and a phone width (390), read the console (it must stay empty), and
   measure with `evaluate_script` when a pixel matters. A change to a
   shared element (the header, a card, a table) is checked on every page
   it appears on.
4. `make lint` and `make test`.
5. Report what you verified and how. Do not commit unless asked; the user
   batches changes.

### The Studio

The Studio is the user's Mac Studio on the tailnet: it runs mlx-serve and
its own mlx-spy as launchd agents. Read `docs/internal/studio.md` before
any ssh command; it has the paths, the safe commands and the rules (never
`GET /props`, never start processes by hand over ssh, never touch the
user's other services). `make deploy-studio` is the only deploy path.
Deploy when asked, then say what is now running there.

### Testing without a browser

- `bun src/main.ts --engine http://<studio>:11234 --once` prints one
  sample: exit 0 when the engine answered, 2 when it did not, 1 on bad
  arguments. From the MacBook the engine is remote, so `enginePid` is
  null, `procRss` 0 and `disk` empty by design.
- Parsers and rate math are pure and tested on recorded fixtures in
  `test/fixtures/`. Record new ones with `curl <engine>/metrics.json` and
  `curl <engine>/v1/models`, pretty-printed. Never record `/props`.
- `handle()` in `src/web.ts` is separate from `serve()`, so tests call it
  with a `Request`.
- `test/fixtures/ws/*.ndjson` are chat event sequences recorded from the
  preview's `/ws` with `bun scripts/record-ws.ts <file> --note "..."`
  while the chat is driven in Chrome; the first line is the note, `t` is
  milliseconds since the first message. Record a new one for every chat
  bug before fixing it (`plans/26.09.09-preact-plan.md`, "Recorded event
  fixtures").

## Rules that protect the engine

1. **Never call `GET /props` on mlx-serve.** It goes through the model-load
   path and cold-loads the default model: it undoes API unloads, evicts the
   model a client just loaded and halves decode speed during a request.
   The adapter uses only endpoints answered before the load step:
   `/health`, `/metrics.json`, `/v1/models`. Anything new is verified the
   same way in mlx-serve's `src/server.zig` first.
2. **The sampler is read-only.** `load`, `unload`, `restart` and
   `diskClear` run only from an explicit user action through the actions
   layer, are logged, and are disabled when the engine URL is not local.
   The chat runner is the only other engine caller: it posts to
   `/v1/chat/completions` (always streaming, so the engine cancels the slot
   when mlx-spy aborts) only when a user sends a message, and a message
   naming a non-resident model cold-loads it on purpose. The chat tools
   (`src/tools/`) are the only other network callers: `webfetch` reads what
   the model asks for, the engine included (the user's decision), and
   refuses only this host's loopback addresses; `websearch` posts the
   model's query to `mcp.exa.ai` or `api.firecrawl.dev`, the chat's choice.
3. **No spawns on the monitor path.** Host numbers come from FFI, directory
   sizes from recursive stat. The only spawns are the two local-only
   actions: `launchctl kickstart -k gui/<uid>/<label>` for "free" and the
   deletion of the disk cache contents for "disk clear". The cache path
   comes from the adapter's allow-list, never from the request.
4. **Fail fast on the engine.** Sampler requests time out in 3 s and a
   failed read produces a sample with `engineUp: false`; a hung engine
   never stalls the loop.

## Layout

```
src/main.ts          entry: CLI parsing (--engine, --listen, --db, --retention,
                     --hot-cache-max, --disk-cache-max, --once, -h, -v); wires
                     sampler, history and server; dev VERSION from package.json,
                     release VERSION injected at build time
src/engine/types.ts  the Engine interface and the normalised metric types
src/engine/openai.ts the OpenAI chat completions wire, shared by every engine:
                     buildChatBody, parseSse, chatEvents, ToolCallTracker,
                     streamChat (pure parts tested on recorded and hand-made
                     frames)
src/engine/mlxserve.ts
                     mlx-serve adapter: parseMetrics/parseModels (pure, tested),
                     the HTTP client, load/unload, cache dir and log paths,
                     cacheLimits() from the LaunchAgent plist; its chat layer
                     adds enable_thinking, reasoning_effort and timings
src/sample.ts        Sample type; computeRates and buildSample (pure, tested);
                     takeSample does the I/O for --once
src/requests.ts      trackRequests: the request in flight and the last
                     finished one, from the counter deltas (pure, tested)
src/sampler.ts       the 1 Hz loop; carries epoch, counters and the last
                     request across restarts through the history meta table
src/history.ts       ring buffer (1 h) plus bun:sqlite: samples (7 day
                     retention, bucketed series() for uPlot), models (ids and
                     the favorite flag), requests (the last 50)
src/chats.ts         ChatStore: chats and messages over the same sqlite file
src/chat.ts          ChatRunner: the one send in flight, rounds of engine
                     requests with tool calls between them, partial reply
                     written every 250 ms or 2 KB, deltas and rendered HTML
                     on /ws, stop from any tab, regenerate, edit
src/tools.ts, src/tools/
                     the tool registry the runner executes: get_current_time,
                     webfetch (with the network guard), websearch; pure parts
                     tested
src/tools/search/    the search providers: types.ts (the names and the key
                     type, no I/O), exa.ts and firecrawl.ts (build the
                     request, parse the answer; pure, tested on fixtures)
src/markdown.ts      renderMarkdown(): the safety boundary for model output
src/actions.ts       load, unload, default, free, diskClear (local-only),
                     historyClear, favorite; one at a time, logged, last 50
src/web.ts           Bun.serve: the page, /api/snapshot, /api/history,
                     /api/requests, POST /api/actions/<name>, /api/chats and
                     sub-routes, /ws; development mode from MLX_SPY_DEV=1;
                     handle() separate from serve() for tests
src/ui/index.html    the shell: head, the header, page and footer roots,
                     the script tag; Bun bundles style.css and main.tsx
                     from it
src/ui/main.tsx      entry: renders the shell and the page's root, opens
                     the store
src/ui/store.ts      the WebSocket client and its signals (connection,
                     snapshot, sample, models, event, busy); listen() for
                     the chat's event routing
src/ui/api.ts        api<T>(): one JSON call to this server
src/ui/format.ts     gb, num, count, secs, tps, when, group (pure, tested)
src/ui/icons.tsx     the inline SVGs as components
src/ui/shell/        Header.tsx, Footer.tsx, Pill.tsx, Confirm.tsx (the
                     dialog with a promise API)
src/ui/monitor/      Monitor.tsx (the page: range, series and tile memory
                     signals), Tiles.tsx, Charts.tsx (uPlot in a ref),
                     Models.tsx, Runtime.tsx, RangePicker.tsx, RequestBar.tsx,
                     Event.tsx; the pure, tested tiles.ts (seed/apply and
                     the eight tiles), range.ts, series.ts, request.ts;
                     actions.ts (runAction, confirmText, engine facts)
src/ui/requests/     Requests.tsx, Row.tsx
src/ui/chat/         the Chat page. Pure and tested on the recordings in
                     test/fixtures/ws/: stream.ts (one streaming row:
                     liveOf, applyDelta, applyHtml, finish; offsets and
                     gaps), events.ts (ChatState and applyEvent, the
                     reducer over the socket events), thread.ts
                     (groupRows: the user rows, work groups and replies
                     the transcript renders, computed from the state so a
                     reload shows what a live tab shows). store.ts (the
                     signals: chats, state, draft, running, note, opened
                     blocks; the commands: send, patch, regenerate),
                     nav.ts (open() with its token, showDraft, the socket
                     routing with the pending queue while a fetch is in
                     flight, boot). Components: Chat.tsx, List.tsx,
                     Header.tsx, ModelPicker.tsx, Settings.tsx, Thread.tsx
                     (the scroll stickiness), Reply.tsx, UserRow.tsx,
                     Think.tsx, Tool.tsx, Work.tsx, Composer.tsx,
                     Stats.tsx, Context.tsx, Empty.tsx
src/ui/style.css     follows the engine's own console (its tokens: #131314
                     page, #1e1f20 cards, #0f1216 inset tiles, 10px uppercase
                     labels, bold mono values)
src/host/            probes: darwin.ts (bun:ffi, offsets verified with
                     offsetof(), load-bearing comments), info.ts (static host
                     facts), disk.ts (cache dir sizes, no spawn), local.ts
                     (is the engine on this host), index.ts (facade)
test/                bun test suites; fixtures/ holds recorded engine bodies,
                     fixtures/ws/ recorded /ws chat event sequences (ndjson),
                     ui/ the client's pure modules (the chat ones driven
                     over every recording by ui/ws.ts) and render-to-string
                     checks of its components
docs/                user docs: monitor, chat, api (keep in step with web.ts),
                     development; internal/studio.md is the Studio guide
scripts/             preview.sh (make preview), deploy-studio.sh (make
                     deploy-studio), record-ws.ts (records /ws chat events
                     from the preview into test/fixtures/ws/),
                     studio.env.example, and copies of the two Studio
                     LaunchAgent plists (mlx-spy and mlx-serve)
plans/               the development plan and milestones
```

Data flow: adapter (`/metrics.json`, `/v1/models`) → `Reading` →
`computeRates` over the previous reading, joined with the host probes →
`buildSample` → History (ring + SQLite) and listeners → `/api/snapshot`,
`/api/history` and the `/ws` push → the page. Actions go the other way: a
button → confirm dialog → `POST /api/actions/<name>` → `Actions.run` → an
event on `/ws` that every tab shows. A chat message: composer →
`POST /api/chats/<id>/messages` → `ChatRunner.send` → `{type: "chat"}`
events on `/ws` in every tab → `done` with the final row and its stats.

## mlx-serve specifics worth knowing

- Model ids are `<org>/<name>` in serve mode.
- `generation_tokens_live` and `prefill_tokens_live` hold the token count of
  the current request and drop back when a new one starts, so a negative
  delta means "new request", not a reset. Counters (`*_total`) only go
  backwards on a process restart; that bumps the epoch.
- `memory_mb` is the process footprint (matches libproc's phys footprint);
  `mlx_active_bytes` is weights plus KV; `mlx_cache_bytes` is MLX's
  reclaimable pool, not the prefix cache. The hot prefix cache has no
  gauge, so it is estimated as active minus the loaded models'
  `bytes_resident` and labelled as such.
- The engine does not say which model is the default, nor which model
  served a request; mlx-spy attributes a request to the resident favorite,
  else the first resident by id.
- Disk tier at `~/.mlx-serve/kv-cache/<fingerprint>/`; server log at
  `~/.mlx-serve/logs/mlx-serve-<port>.log`. The service label is
  `com.ddalcu.mlx-serve`; "free" is a `launchctl kickstart -k` because a
  fresh process has no default model and so nothing to cold-load.
- `--prefix-cache-mem` and `--prefix-cache-disk` are per resident model
  (verified 2026-09-07 in `scheduler.zig` at 0897f01). No endpoint reports
  them, so the adapter reads the plist's ProgramArguments; the tiles
  multiply the budget by the resident model count (hot) and the tier dir
  count (SSD).
- The hot cache evicts per workload since 26.9.2, keyed by
  `prompt_cache_key`. The runner sends the chat id, so another client's
  batch evicts its own entries before a chat in progress.
- Host memory on macOS: `free` is small by design; free + inactive is the
  practical headroom. `compressed` is the compressor's page count.

## Conventions

- **Style is enforced by Biome** (`biome.json`): 2-space indent, double
  quotes, semicolons, trailing commas, 80 columns. Biome also rejects a
  selector of lower specificity after a higher one that matches the same
  element; order CSS rules accordingly.
- **Types** are checked by `bun tsc --noEmit` as part of `make lint`. The
  browser client shares the tsconfig (lib includes DOM).
- **Comments explain why, not what.** The engine caveats above are
  load-bearing where they appear in code; keep them.
- **Development builds report `v0.0.0-dev`.** `package.json` stays at
  `0.0.0-dev`; tagged releases inject `v<semver>` through
  `make build VERSION=...` and verify the compiled binary. Do not edit the
  package version for a release.
- **Pure logic separate from I/O.** Parsers and rate math take plain data
  and are tested on fixtures; fetches and sleeps live in thin wrappers.
- **UI copy is short and plain.** Labels are one or two words ("idle",
  "No requests yet."); no filler sentences to fill space, keep the height
  with CSS instead. Empty states keep the layout of the filled state so
  nothing jumps when data arrives.
- **Docs move with the code.** A change to a page updates `docs/monitor.md`
  or `docs/chat.md`; a route change updates `docs/api.md`; a change to the
  Studio setup updates `docs/internal/studio.md`, after it was run there.
- No em-dashes in prose or docs. `perl -i -pe` for global replaces, not
  sed. `uv` for ad hoc Python, never pip. No `Co-authored-by` or session
  trailers in commits or PRs. npm packages official only, exact pins,
  `bun install --ignore-scripts`, 24 h cooldown on new releases.
