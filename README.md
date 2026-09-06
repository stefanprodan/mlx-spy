# mlx-spy

Monitoring and control for LLM inference servers on Apple Silicon.

mlx-spy runs next to an inference engine (mlx-serve first), samples the
engine and the host once a second, keeps history, and serves a dashboard
with the control actions the engine's own console lacks. It never calls the
engine endpoints that trigger a model load. See `plans/` for the roadmap.

## Status

Milestone 3: the sampler runs at 1 Hz, keeps 7 days of history in SQLite,
reads host memory, the engine process footprint and the SSD cache tier size
through libproc and Mach (no subprocesses), and serves a JSON API. No page
yet.

```sh
bun src/main.ts --engine http://127.0.0.1:11234            # serve the API
bun src/main.ts --engine http://127.0.0.1:11234 --once     # one sample
```

By default it binds the host's Tailscale address (else 127.0.0.1) on port
11235 and writes `~/.mlx-spy/history.sqlite`. There is no auth: the tailnet
is the boundary.

- `GET /api/snapshot` latest sample and the model list
- `GET /api/history?range=1h|6h|24h|7d` columnar series, bucketed for the
  longer ranges

A sample carries the engine state, windowed decode and prefill tok/s, cache
hit ratios, the memory split (host free, inactive, wired and compressed;
engine footprint and RSS; weights, estimated hot cache, MLX pool), the cache
tier directories and the model list. The engine pid, RSS and disk tier are
only probed when the engine runs on the same host.

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
