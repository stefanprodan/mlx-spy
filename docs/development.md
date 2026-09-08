# Development

Bun 1.4 or newer, macOS on Apple Silicon for the host probes (elsewhere
they return zeros and the engine numbers still work).

```sh
bun install --ignore-scripts
make dev ARGS="--engine http://127.0.0.1:11234"   # live reload
make lint                                         # Biome + tsc
make test                                         # bun test
make build                                        # standalone binary in bin/
make install-bin                                  # build and install to ~/.local/bin
```

Useful flags while developing: `--listen 127.0.0.1:11299` to keep a second
instance off the default port, `--db :memory:` to keep nothing, `--once`
to print one JSON sample and exit (exit code 2 when the engine did not
answer).

The page is bundled by Bun from `src/ui/index.html`: once at startup in
the compiled binary, on demand with hot reload when `MLX_SPY_DEV=1` is set,
which `make dev` and `make preview` do. `make preview` (re)starts a
detached instance on `127.0.0.1:11236` against the engine named in
`scripts/studio.env` (`make preview-stop`, `make preview-log`,
`make preview-clean` to also wipe its db and log).

## Layout

`AGENTS.md` at the repository root describes every module, the data flow,
the rules that protect the engine and the conventions (Biome style,
comments that explain why, pure logic tested on recorded fixtures). Read it
before changing anything; it is written for humans too.

## Tests

`bun test` runs the suites under `test/`. Parsers and rate math are tested
on fixtures recorded from a live engine (`test/fixtures/`): `/metrics.json`
and `/v1/models` bodies, and a recorded chat stream. Record new ones with
`curl` and never record `/props`.
