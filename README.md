# mlx-spy

Monitoring, control and chat for LLM inference servers on Apple Silicon.

mlx-spy runs next to an inference engine (mlx-serve first), samples it and
the host once a second, keeps a week of history, and serves three pages:

- **Monitor**: live tok/s, cache efficiency, memory split, charts with a
  1h to 7d range, the models table with load, unload and default buttons,
  restart engine and clear disk cache.
- **Requests**: the request in flight and the last 50 finished ones with
  their prompt, cached share, prefill, decode and time to first token.
- **Chat**: a chat on the engine with the engine's own timings under every
  reply. Replies stream on the server, so a reload or a second tab picks
  up where the reply is, and Stop works from anywhere at any point.

One Bun binary, no runtime dependencies, nothing loaded from the internet.

<!-- screenshots -->

## Install

Requires Bun 1.4 or newer.

```sh
git clone https://github.com/stefanprodan/mlx-spy
cd mlx-spy
bun install --ignore-scripts
make install-bin        # builds a standalone binary into ~/.local/bin
```

The chat's `websearch` tool works without keys. To use your Exa or
Firecrawl key, put the bare key in `~/.local/secrets/exa.key` or
`~/.local/secrets/firecrawl.key` (next to the binary's directory, mode
600 recommended). The files are read at start, so a change needs a
restart.

## Run

```sh
mlx-spy                                    # engine at http://127.0.0.1:11234
mlx-spy --engine http://studio:11234       # a remote engine
mlx-spy --once                             # one JSON sample on stdout
```

The dashboard binds the host's Tailscale address (else 127.0.0.1) on port
11235. There is no authentication: the tailnet is the boundary. History and
chats live in `~/.mlx-spy/history.sqlite`.

| Flag | Default | Meaning |
|---|---|---|
| `--engine <url>` | `http://127.0.0.1:11234` | engine base URL |
| `--listen <host:port>` | Tailscale address, port 11235 | bind address |
| `--db <path>` | `~/.mlx-spy/history.sqlite` | SQLite file; `:memory:` keeps nothing |
| `--retention <days>` | 7 | sample history kept |
| `--hot-cache-max`, `--disk-cache-max` | from the engine's launchd plist | per-model cache budgets for the tiles, e.g. `16GB` |

Restart engine, clear disk cache and the process probes (pid, RSS, CPU)
only work when the engine runs on the same host.

## Docs

- [Monitor and Requests](docs/monitor.md)
- [Chat](docs/chat.md)
- [API](docs/api.md)
- [Development](docs/development.md)

## License

Apache-2.0
