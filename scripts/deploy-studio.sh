#!/usr/bin/env bash
# Build mlx-spy, install the binary on the Mac Studio and restart its
# launchd agent. Paths, rules and the manual steps: docs/internal/studio.md.
set -euo pipefail

cd "$(dirname "$0")/.."
# the host lives in an untracked file, so the repo names no machine
[ -f scripts/studio.env ] || { echo "scripts/studio.env missing; copy studio.env.example" >&2; exit 2; }
. scripts/studio.env
HOST=$STUDIO_SSH
LABEL=com.stefanprodan.mlx-spy
URL=http://$STUDIO_HOST:11235
ssh_() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "$@"; }

make build
scp -q bin/mlx-spy "$HOST:~/.mlx-spy/bin/mlx-spy.new"
# a swap plus a kickstart: launchd sends SIGTERM (chats in flight are
# marked interrupted, the db closes) and starts the new binary; nothing
# is started by hand over ssh, so the session never hangs on a child
ssh_ "mv ~/.mlx-spy/bin/mlx-spy.new ~/.mlx-spy/bin/mlx-spy && launchctl kickstart -k gui/$(id -u)/$LABEL"
for _ in $(seq 1 20); do
  sleep 1
  if curl -sf -o /dev/null "$URL/api/snapshot"; then
    echo "mlx-spy $(ssh_ "~/.mlx-spy/bin/mlx-spy -v") up at $URL"
    exit 0
  fi
done
echo "mlx-spy did not answer at $URL; log tail:" >&2
ssh_ "tail -5 ~/.mlx-spy/mlx-spy.log" >&2
exit 1
