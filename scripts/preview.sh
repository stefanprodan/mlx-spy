#!/usr/bin/env bash
# The local preview: mlx-spy from source against the Studio's engine, on
# 127.0.0.1:11236, detached, with its pid, db and log under .preview/
# (`clean` stops it and removes them).
# MLX_SPY_DEV=1 turns on Bun's dev server: style.css hot-reloads in the
# browser, an edit under src/ui/ reloads the page; --watch restarts the
# process on server-side TypeScript changes.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT=${PREVIEW_PORT:-11236}
DIR=.preview
PID=$DIR/pid
LOG=$DIR/log
URL=http://127.0.0.1:$PORT

running() { [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; }

stop() {
  if running; then
    kill "$(cat "$PID")"
    for _ in $(seq 1 50); do running || break; sleep 0.1; done
  fi
  # a process from an older start, or one started by hand on the port
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true
  rm -f "$PID"
}

start() {
  [ -f scripts/studio.env ] || { echo "scripts/studio.env missing; copy studio.env.example" >&2; exit 2; }
  . scripts/studio.env
  mkdir -p "$DIR"
  MLX_SPY_DEV=1 nohup bun --watch src/main.ts --engine "http://$STUDIO_HOST:11234" \
    --listen "127.0.0.1:$PORT" --db "$DIR/history.sqlite" >"$LOG" 2>&1 &
  echo $! >"$PID"
  for _ in $(seq 1 50); do
    if curl -sf -o /dev/null "$URL/api/snapshot"; then
      echo "preview up at $URL (pid $(cat "$PID"), log $LOG)"
      return 0
    fi
    running || break
    sleep 0.2
  done
  echo "preview did not answer at $URL; log tail:" >&2
  tail -20 "$LOG" >&2
  exit 1
}

case "${1:-restart}" in
  start) running && { echo "preview already up at $URL (pid $(cat "$PID"))"; exit 0; }; start ;;
  stop) stop; echo "preview stopped" ;;
  clean) stop; rm -rf "$DIR"; echo "preview stopped, $DIR removed" ;;
  restart) stop; start ;;
  status) if running; then echo "preview up at $URL (pid $(cat "$PID"))"; else echo "preview not running"; exit 1; fi ;;
  log) tail -n "${2:-40}" "$LOG" ;;
  *) echo "usage: $0 start|stop|restart|status|clean|log [lines]" >&2; exit 1 ;;
esac
