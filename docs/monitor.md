# Monitor and Requests

## Monitor

The Monitor page is the engine at a glance, one sample per second, with
seven days of history in SQLite so every tab and every reload shows the
same series.

- **Tiles**: requests served, tokens generated, prefill and decode tok/s,
  cache efficiency, memory, RAM cache and SSD cache. The cache tiles draw
  a bar against the engine's per-model budgets, read from its launchd
  plist when the engine is local or given with `--hot-cache-max` and
  `--disk-cache-max`. A value with nothing behind it (no request in the
  range, a probe that needs a local engine) is a dimmed dash; counts stay
  at 0. The line under a value is a related fact or empty, so the tiles
  keep their size when the engine is idle.
- **Charts** with a shared cursor and a 1h, 6h, 24h, 7d range picker. The
  1h range is raw seconds and grows live; longer ranges are bucket
  averages, re-fetched every minute.
- **The request bar**: the request in flight (start time, tokens so far,
  time spent prefilling and decoding) or the last one finished with its
  prompt size and cached share.
- **Models** (or "No models found." and "Engine unreachable." as one line when
  there are none): every model the engine lists, the daily driver first and
  the rest by id so nothing moves on a load, with its state, size and
  context, and the buttons: load, unload, make default, plus the
  daily-driver star (mlx-spy's own mark). A failed action is reported
  under the table; a success shows in the list or the uptime. Unload, the daily-driver toggle and a load into an empty
  engine run at once; loading next to a resident model asks first and
  shows the estimated engine memory after the load (its footprint now
  plus the model's weights); the rest ask for confirmation. The Download
  button in the section head asks for a Hugging Face repository
  (`owner/name` or its URL) and fetches it into the model directory
  (`--model-dir`); the pull is a row at the top of the table with the
  bytes so far, the speed, the time left, a delete button (asks first;
  stops the download and removes its files) and a pause button, which
  becomes resume once it stopped. A finished download becomes the
  model's own row once the engine lists it. A download that fails says
  why under the table.
- **Runtime**: the engine process (pid, RSS, CPU, GPU, weights) next to
  host facts (OS, chip, cores, GPU cores, memory, disk), plus Restart
  engine and Clear disk cache. Those two, and the process probes, only
  work when the engine runs on the same host.

The engine reports counts, not requests: with several requests in flight
the bar and the tiles describe the engine as a whole.

## Requests

The Requests page moves the live bar over and lists the last 50 finished or
cancelled requests under it: when it finished, the model (the engine does
not say which one served it, so it is the resident model, the favorite
when several are resident), prompt and cached tokens, generated tokens,
prefill and decode time, time to first token and the total. A cancelled
request shows its finish time in amber. Each row opens on a click (the
chevron in front of the time) to a panel with every field, including the
full model id, the start time and the outcome; a phone hides most columns
and the panel is where they are. The bin in the History head deletes the
stored requests and the last request in the bar.

## Memory numbers

Memory is shown in binary GB, the unit About This Mac uses; only the host
disk is decimal, as Finder labels it. The engine's footprint is what it
reports itself; RSS comes from libproc when the engine is local. "RAM
cache" is an estimate: the MLX allocator's active bytes minus the loaded
weights, because the engine has no gauge for its hot prefix cache.
