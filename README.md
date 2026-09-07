# mlx-spy

Monitoring and control for LLM inference servers on Apple Silicon.

mlx-spy runs next to an inference engine (mlx-serve first), samples the
engine and the host once a second, keeps history, and serves a dashboard
with the control actions the engine's own console lacks. It never calls the
engine endpoints that trigger a model load. See `plans/` for the roadmap.

## Status

Milestone 5: the sampler runs at 1 Hz, keeps 7 days of history in SQLite,
reads host memory, the engine process footprint and the SSD cache tier size
through libproc and Mach (no subprocesses), and serves a dark dashboard:
tile row, uPlot graphs with a shared cursor and a 1h/6h/24h/7d range
picker, and the models table with the control buttons: load, unload, set
default, free RAM (a launchd restart of the service) and clear disk cache.
Every action asks for confirmation, is logged, and the last two only work
when the engine runs on the same host.

```sh
bun src/main.ts --engine http://127.0.0.1:11234            # serve the dashboard
bun src/main.ts --engine http://127.0.0.1:11234 --once     # one sample
```

By default it binds the host's Tailscale address (else 127.0.0.1) on port
11235 and writes `~/.mlx-spy/history.sqlite`, which holds the samples and
the model list with your daily-driver star (dropped when the engine stops
listing a model). There is no auth: the tailnet is the boundary.

- `GET /` the dashboard
- `GET /api/snapshot` latest sample and the model list
- `GET /api/history?range=1h|6h|24h|7d` columnar series, bucketed for the
  longer ranges
- `WS /ws` a snapshot on connect, then one sample per second and an event
  per finished action
- `POST /api/actions/load|unload|default` with `{"model": "<id>"}`, and
  `POST /api/actions/free|diskClear` (local engine only), and
  `POST /api/actions/historyClear` (wipes mlx-spy's own sample database),
  `POST /api/actions/favorite` with `{"model"}` (toggles the daily-driver star)

A sample carries the engine state, live decode and prefill tok/s (rated between
moves of the engine's 2 s live gauges, carried while the phase runs), cache
hit ratios, the memory split (host free, inactive, wired and compressed;
engine footprint and RSS; weights, estimated RAM cache, MLX pool), the cache
tier directories and the model list. The engine pid, RSS, CPU, start time
and disk tier are only probed when the engine runs on the same host; the
Runtime section shows them next to facts about the host (OS, chip, cores,
GPU cores, memory, disk). The RAM cache and SSD
cache tiles draw a bar against the engine's per-model budgets, read from its
launchd plist for a local engine or given with `--hot-cache-max` and
`--disk-cache-max`.

## Development

Requires Bun 1.4 or newer.

```sh
bun install --ignore-scripts
make lint    # Biome + tsc
make test    # bun test
make build   # standalone binary in bin/
```

## License

Apache-2.0
