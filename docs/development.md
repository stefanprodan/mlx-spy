# Development

Bun 1.4 or newer, macOS on Apple Silicon for the host probes (elsewhere
they return zeros and the engine numbers still work).

```sh
bun install --ignore-scripts
make dev ARGS="--engine http://127.0.0.1:11234"   # live reload
make lint                                         # Biome + tsc
make test                                         # bun test
make build                                        # v0.0.0-dev binary in bin/
make build VERSION=v1.2.3                         # inject a release version
make install-bin                                  # build and install to ~/.local/bin
```

`package.json` stays at `0.0.0-dev`. A normal source or binary build reports
`v0.0.0-dev`; `make build VERSION=v1.2.3` uses Bun's build-time definition
to embed `v1.2.3` without editing the package file.

A pushed semantic-version tag such as `v1.2.3` runs the release workflow.
It validates the tag, runs lint and tests, builds a native Darwin ARM64
binary with the tag injected, verifies `mlx-spy --version`, then publishes
an archive, SHA-256 checksum and build-provenance attestation. A version
with a hyphen, such as `v1.2.3-rc.1`, becomes a prerelease.

Useful flags while developing: `--listen 127.0.0.1:11299` to keep a second
instance off the default port, `--db :memory:` to keep nothing, `--once`
to print one JSON sample and exit (exit code 2 when the engine did not
answer).

The page is bundled by Bun from `src/ui/index.html`: once at startup in
the compiled binary, on demand when `MLX_SPY_DEV=1` is set, which
`make dev` and `make preview` do; then a CSS edit hot-reloads and an edit
to the client's TypeScript reloads the page. The client is Preact with
signals (`src/ui/main.tsx`, `store.ts`, `shell/`, `monitor/`, `requests/`,
`chat/`), bundled like uPlot so the binary still has no runtime
dependencies. Logic lives in plain `.ts` modules that take data and return
data (the tiles, the chart series, the chat's delta reducer and transcript
tree) and is tested on recorded fixtures; components hold only what the
DOM owns (uPlot, dialogs, timers, scroll). A new component gets a
render-to-string check in `test/ui/` asserting the class names
`style.css` depends on; a chat behaviour change starts with a recording
under `test/fixtures/ws/` (see `scripts/record-ws.ts`). `make preview` (re)starts a
detached instance on `127.0.0.1:11236` against the engine named in
`scripts/studio.env` (`make preview-stop`, `make preview-log`,
`make preview-clean` to also wipe its db and log).

The chat's `websearch` tool reads its provider keys from
`../secrets/{exa,firecrawl}.key` relative to the binary's directory
(`~/.local/secrets/` after `make install-bin`) and, when run from source,
from `.preview/secrets/` in the repository, which is git-ignored. The
model downloader reads a Hugging Face token from `hf.key` in the same
directory, for gated repositories and the Hub's higher rate limits. Each
file holds the bare key; the start log says `exa key: <path>` or `exa
key: none`, and the same for firecrawl and hf. The files are read once at
start, so a change needs a restart, and a keyless check needs the file
moved away.

Downloads land in `--model-dir`, `~/.mlx-spy/models` by default and
`.preview/models/` for the preview; point it at the engine's own model
directory for a downloaded model to be served. The downloader is tested
against a fake Hub in `test/pull.test.ts`; a real pull of a small
repository such as `Jundot/gemma-4-E2B-it-oQ4e-mtp` (3.9 GB) is the
end-to-end check.

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
