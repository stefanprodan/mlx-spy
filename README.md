# mlx-spy

Monitoring and control for LLM inference servers on Apple Silicon.

mlx-spy runs next to an inference engine (mlx-serve first), samples the
engine and the host once a second, keeps history, and serves a dashboard
with the control actions the engine's own console lacks. It never calls the
engine endpoints that trigger a model load. See `plans/` for the roadmap.

## Status

Milestone 1: one JSON sample and exit.

```sh
bun src/main.ts --engine http://127.0.0.1:11234 --once
```

The sample carries the engine state, windowed decode and prefill tok/s,
cache hit ratios, the memory split (weights, estimated hot cache, MLX pool,
process footprint) and the model list.

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
