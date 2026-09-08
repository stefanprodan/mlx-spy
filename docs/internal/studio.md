# Operating the Mac Studio

Internal notes for whoever (or whatever) works on the Studio from the
MacBook: the box, the engine (mlx-serve) and mlx-spy itself. Everything
here was run and verified on 2026-09-08 unless dated otherwise. This page
is self-contained on purpose: read it before any ssh command, and extend it
after verifying a new one rather than improvising.

The machine's name is not in the repo. It lives in `scripts/studio.env`
(git-ignored, template in `scripts/studio.env.example`): `STUDIO_SSH` is
the ssh alias, `STUDIO_HOST` the Tailscale name. Every command below
assumes `. scripts/studio.env` was run in the shell first.

## The box

| What | Value |
|---|---|
| Machine | Mac Studio 2023, M2 Max, 96 GB unified memory, headless |
| macOS | 26.6 on Apple Silicon; the account is `stefanprodan`, uid 501 |
| Tailscale | `$STUDIO_HOST`, reachable only from the tailnet; on the box itself use `127.0.0.1` |
| ssh alias | `$STUDIO_SSH` (from the MacBook's `~/.ssh/config`: that host name, user `stefanprodan`, key `~/.ssh/id_ecdsa`, passphrase in the macOS Keychain) |
| Login shell | Homebrew bash; `~/.bashrc` puts Homebrew, GNU make, sed and curl, `~/go/bin` and `~/.local/bin` on the PATH, so `brew`, `uv`, `bun`, `hf`, `mlx-serve`, `sqlite3` resolve in ssh commands |
| Also running | oMLX.app (port 8000, a second inference server, nothing loaded by default) and other services of the user's. Never stop, restart or resize anything you did not start; several GB of memory outside the engine is expected |

The non-interactive form, always:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 $STUDIO_SSH '<command>'
scp -q <file> $STUDIO_SSH:<path>     # use ~ rather than $HOME in scp paths
```

`BatchMode` fails fast instead of prompting. If it fails with
`Permission denied (publickey)`, the agent lost the key and the user has to
run `ssh-add --apple-use-keychain ~/.ssh/id_ecdsa` in a real Terminal. If
the host key changed (a reinstall):
`ssh-keyscan $STUDIO_HOST >> ~/.ssh/known_hosts`.

### Never, on the box

- Never run `osascript`, System Events or any other TCC-gated command over
  ssh: it pops a dialog on the Studio's screen. Use `pgrep`, `launchctl`
  and the APIs.
- Never print env vars or rc files over ssh: the shell profile holds
  credentials. Presence checks only, `[ -n "$VAR" ]`.
- Never start a long-running process by hand over ssh (`nohup ... &`). The
  child inherits the session's descriptors, the ssh command hangs until it
  is killed from the MacBook and a stray `bash -c` wrapper stays behind.
  Both services are launchd agents; use `launchctl`.
- Never touch oMLX or the user's other services beyond reading their state.

## mlx-serve, the engine

| What | Value |
|---|---|
| Version | mlx-serve 26.9.1 from the Homebrew tap `ddalcu/mlx-serve`, binary `/opt/homebrew/bin/mlx-serve` |
| launchd agent | label `com.ddalcu.mlx-serve`, plist `~/Library/LaunchAgents/com.ddalcu.mlx-serve.plist` (the Studio file is what runs; `RunAtLoad`, `KeepAlive`, 10 s throttle) |
| Port | 11234, bound on `0.0.0.0`; from the MacBook `http://$STUDIO_HOST:11234` |
| Models | checkpoints under `~/models/<org>/<name>` (shared with oMLX through the `~/.omlx/models` symlink); serve mode lists them all and ids are `<org>/<name>` |
| Per-request log | `~/.mlx-serve/logs/mlx-serve-11234.log` (rotates at 32 MB) |
| launchd stdout/stderr | `~/.mlx-serve/logs/launchd.log` |
| SSD prefix cache | `~/.mlx-serve/kv-cache/<fingerprint>/`, one dir per model |

The service command, from the plist's `ProgramArguments` (2026-09-07):

```
/opt/homebrew/bin/mlx-serve --serve --model-dir /Users/stefanprodan/models
  --host 0.0.0.0 --port 11234 --metrics
  --prefix-cache-mem 16GB --prefix-cache-disk 50GB
  --mtp --temp 1.0 --top-p 0.95
  --max-resident-models 2 --idle-evict-secs 3600
```

Residency policy: two models may be resident,
`stefanprodan/Ornith-1.5-35B-A3B-BigBang-oQ4e-mtp` (the daily driver, 21.6 GB on disk)
and `Jundot/Qwen3.8-27B-oQ4e-mtp` (17.0 GB); the third listed checkpoint,
`stefanprodan/Apodex-1.1-mini-oQ4e-mtp`, is normally unloaded. `--prefix-cache-mem`
and `--prefix-cache-disk` are per resident model. Never a third large model
in mlx-serve, never a large model in oMLX while mlx-serve holds any (oMLX is
outside its memory accounting). Anything loaded for a probe is unloaded
right after.

### Reading the engine (safe)

```sh
E=http://$STUDIO_HOST:11234
curl -s $E/health
curl -s $E/v1/models | python3 -c 'import sys,json; [print("*" if m["loaded"] else " ", m["id"], m["state"]) for m in json.load(sys.stdin)["data"]]'
curl -s $E/metrics.json | head -c 600
ssh -o BatchMode=yes $STUDIO_SSH 'tail -40 ~/.mlx-serve/logs/mlx-serve-11234.log'
ssh -o BatchMode=yes $STUDIO_SSH 'launchctl print gui/$(id -u)/com.ddalcu.mlx-serve | grep -E "state|pid|last exit"'
```

`/health`, `/v1/models`, `/metrics.json` and `/metrics` answer before the
model-load path. **Never `GET /props`**: it cold-loads the default model,
undoes API unloads and evicts what a client just loaded. The engine's own
web console at the server root polls `/props` every 5 s, so keep that
console closed during measurements. mlx-spy's Monitor page is the
replacement.

### Controlling the engine

Through the API, which is what mlx-spy's buttons do:

```sh
# cold-load a model (4 to 7 s from SSD, weights are mmap'd)
curl -s -X POST $E/v1/load-model -H 'content-type: application/json' -d '{"model":"Jundot/Qwen3.8-27B-oQ4e-mtp"}'
# load it and make it the server default (chat requests without a model go there)
curl -s -X POST $E/v1/load-model -H 'content-type: application/json' -d '{"model":"Jundot/Qwen3.8-27B-oQ4e-mtp","default":true}'
# unload: frees the weights and that model's RAM prefix cache (RSS drops a few seconds later)
curl -s -X POST $E/v1/unload-model -H 'content-type: application/json' -d '{"model":"Jundot/Qwen3.8-27B-oQ4e-mtp"}'
# rescan ~/models after adding a checkpoint
curl -s -X POST $E/v1/models/rescan
```

Through launchd, over ssh:

```sh
# "free": restart the service; nothing loaded, RAM caches gone, no default
# model, SSD tier kept. The only correct way to get an empty engine.
ssh -o BatchMode=yes $STUDIO_SSH 'launchctl kickstart -k gui/$(id -u)/com.ddalcu.mlx-serve'
# stop for real (KeepAlive would otherwise restart it); wait for the exit,
# a bootstrap during the graceful shutdown fails with "Bootstrap failed: 5"
ssh -o BatchMode=yes $STUDIO_SSH 'launchctl bootout gui/$(id -u)/com.ddalcu.mlx-serve; for i in $(seq 1 60); do pgrep -x mlx-serve >/dev/null || break; sleep 1; done'
# start again
ssh -o BatchMode=yes $STUDIO_SSH 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ddalcu.mlx-serve.plist'
# clear the SSD tier (after a free, so nothing is writing it)
ssh -o BatchMode=yes $STUDIO_SSH 'rm -rf ~/.mlx-serve/kv-cache/*'
```

To change the engine flags: `scp -q $STUDIO_SSH:~/Library/LaunchAgents/com.ddalcu.mlx-serve.plist .`,
edit, scp it back, then bootout and bootstrap (kickstart does not reread a
plist). Tell the user what changed; the flags are their policy.

### Never, on the engine

- Never `pkill mlx-serve` or start `mlx-serve --serve` by hand: launchd
  restarts the agent and the two fight over the port.
- Never `GET /props` (above).
- Never download or push checkpoints without an explicit go-ahead.

### Engine facts mlx-spy depends on

- `generation_tokens_live` and `prefill_tokens_live` are per current
  request and drop when a new one starts; `*_total` counters only go
  backwards on a process restart (that bumps mlx-spy's epoch).
- `memory_mb` is the process footprint (matches libproc's phys footprint);
  `mlx_active_bytes` is weights plus KV; `mlx_cache_bytes` is the MLX
  allocator's reclaimable pool, not the prefix cache. The hot prefix cache
  has no gauge.
- The engine does not say which model served a request, nor which model is
  the default. mlx-spy attributes a request to the resident favorite, else
  the first resident by id.
- Thinking is off by default on `/v1/chat/completions`; `enable_thinking`
  or `reasoning_effort` turns it on.

## mlx-spy on the Studio

| What | Where |
|---|---|
| Binary | `~/.mlx-spy/bin/mlx-spy` |
| launchd agent | label `com.stefanprodan.mlx-spy`, plist `~/Library/LaunchAgents/com.stefanprodan.mlx-spy.plist`, reference copy `scripts/com.stefanprodan.mlx-spy.plist` in this repo; `RunAtLoad` and `KeepAlive` (5 s throttle), so it comes back on a crash and at login |
| Arguments | `--engine http://127.0.0.1:11234` only: the defaults bind the Tailscale address on port 11235 and use the default db |
| URL | `http://$STUDIO_HOST:11235` (the Tailscale address only; `127.0.0.1:11235` on the box answers nothing) |
| Database | `~/.mlx-spy/history.sqlite` (WAL mode, so `-shm` and `-wal` files sit next to it) |
| Log | `~/.mlx-spy/mlx-spy.log` (stdout and stderr of the agent, appended) |
| Working dir | `~/.mlx-spy` |

Checks:

```sh
ssh -o BatchMode=yes $STUDIO_SSH 'launchctl print gui/$(id -u)/com.stefanprodan.mlx-spy | grep -E "state|pid|last exit"'
ssh -o BatchMode=yes $STUDIO_SSH 'tail -20 ~/.mlx-spy/mlx-spy.log'
ssh -o BatchMode=yes $STUDIO_SSH '~/.mlx-spy/bin/mlx-spy -v'
curl -s http://$STUDIO_HOST:11235/api/snapshot | head -c 300
```

### Deploy

```sh
make deploy-studio
```

That runs `scripts/deploy-studio.sh`: `make build`, scp the binary to
`~/.mlx-spy/bin/mlx-spy.new`, one ssh command that moves it into place and
runs `launchctl kickstart -k gui/$(id -u)/com.stefanprodan.mlx-spy`, then
polls `/api/snapshot` until the new process answers (about 45 s, most of
it the 62 MB upload). Exit code 0 with the version printed means the deploy
is verified; anything else prints the log tail.

Manually, the same three steps:

```sh
make build
scp -q bin/mlx-spy $STUDIO_SSH:~/.mlx-spy/bin/mlx-spy.new
ssh -o BatchMode=yes $STUDIO_SSH 'mv ~/.mlx-spy/bin/mlx-spy.new ~/.mlx-spy/bin/mlx-spy && launchctl kickstart -k gui/$(id -u)/com.stefanprodan.mlx-spy'
```

Kickstart sends SIGTERM: mlx-spy marks streaming chats interrupted, closes
the db and exits; launchd starts the new binary at once. The upload goes to
a `.new` name and is moved because the running binary must not be
overwritten in place.

Stop for real and start again:

```sh
ssh -o BatchMode=yes $STUDIO_SSH 'launchctl bootout gui/$(id -u)/com.stefanprodan.mlx-spy'
ssh -o BatchMode=yes $STUDIO_SSH 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stefanprodan.mlx-spy.plist'
```

`pkill` alone does nothing useful: KeepAlive restarts it in 5 s.

### Changing the agent

Edit `scripts/com.stefanprodan.mlx-spy.plist`, then:

```sh
scp -q scripts/com.stefanprodan.mlx-spy.plist $STUDIO_SSH:~/Library/LaunchAgents/com.stefanprodan.mlx-spy.plist
ssh -o BatchMode=yes $STUDIO_SSH 'launchctl bootout gui/$(id -u)/com.stefanprodan.mlx-spy; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stefanprodan.mlx-spy.plist'
```

### The database

The schema is in `src/history.ts` (samples, meta, models, requests) and
`src/chats.ts` (chats, messages). Fixes go in with `sqlite3` on the box.
Two rules:

- **Stop the agent first** (`launchctl bootout`), fix, then `bootstrap`.
  The sampler rewrites its `meta` row (`key = 'sampler'`, a JSON value
  carrying the epoch, counters and the last request) every second, so an
  edit to that row made while it runs is overwritten within a tick.
- The samples table can be trimmed from the page (Clear history); never
  delete the `models` table, it holds the favorite flag.

Example, the 2026-09-08 backfill of request rows stored before the model
attribution existed:

```sh
ssh -o BatchMode=yes $STUDIO_SSH 'launchctl bootout gui/$(id -u)/com.stefanprodan.mlx-spy; sqlite3 ~/.mlx-spy/history.sqlite "
UPDATE requests SET model = \"Jundot/Qwen3.8-27B-oQ4e-mtp\" WHERE model IS NULL;
UPDATE meta SET value = json_set(value, \"$.lastRequest.model\", \"Jundot/Qwen3.8-27B-oQ4e-mtp\") WHERE key = \"sampler\" AND json_extract(value, \"$.lastRequest.model\") IS NULL;
SELECT model, count(*) FROM requests GROUP BY model;"; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stefanprodan.mlx-spy.plist'
```

Read-only queries need no stop:

```sh
ssh -o BatchMode=yes $STUDIO_SSH 'sqlite3 ~/.mlx-spy/history.sqlite "SELECT count(*) FROM samples; SELECT id, favorite FROM models;"'
```

### A one-off sample without deploying

```sh
make build && scp -q bin/mlx-spy $STUDIO_SSH:/tmp/mlx-spy
ssh -o BatchMode=yes $STUDIO_SSH '/tmp/mlx-spy --once --engine http://127.0.0.1:11234; rm /tmp/mlx-spy'
```

Exit code 0 when the engine answered, 2 when it did not.
