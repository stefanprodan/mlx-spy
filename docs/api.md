# API

mlx-spy serves its pages and a small JSON API from one port (11235 by
default). There is no authentication: the tailnet is the boundary, and the
browser-facing routes check that a request with an `Origin` header comes
from the dashboard's own host. Every JSON response carries
`cache-control: no-store`.

## Pages

| Path | Page |
|---|---|
| `GET /` | Monitor: tiles, charts, models, runtime |
| `GET /requests` | The request in flight and the last 50 finished ones |
| `GET /chat`, `GET /chat/<id>` | Chat |

## Monitoring

| Route | Answer |
|---|---|
| `GET /api/snapshot` | the latest sample, the model list, the engine's capabilities and cache budgets, host facts, the action log, the downloads and the model directory |
| `GET /api/history?range=1h\|6h\|24h\|7d` | columnar series for the charts; 1h is raw seconds, longer ranges are bucket averages |
| `GET /api/requests` | the last 50 finished or cancelled requests, newest first |

A sample carries the engine state, live decode and prefill tok/s, cache hit
ratios, the memory split (host free, inactive, wired and compressed; engine
footprint and RSS; weights, estimated RAM cache, MLX pool), the cache tier
directories, the model list, and the request in flight or the last one
finished. The engine reports counts, not requests, so with several in
flight the numbers describe the engine as a whole.

## Actions

`POST /api/actions/<name>` with a JSON body. Every action is checked against
the engine's capabilities and the current model list, runs one at a time,
and is logged. The answer is the log row: `{t, action, model, ok, ms,
detail}`.

| Name | Body | Effect |
|---|---|---|
| `load` | `{"model": "<id>"}` | load a model and make it the engine default |
| `unload` | `{"model": "<id>"}` | unload it; a model still resident becomes the default |
| `default` | `{"model": "<id>"}` | make a model the default, loading it if needed |
| `free` | none | restart the engine service to free its RAM (local engine only) |
| `diskClear` | none | restart, then delete the SSD cache tier contents (local engine only) |
| `historyClear` | none | wipe mlx-spy's own sample history; chats are kept |
| `requestsClear` | none | wipe the stored requests and the last request in the bar; samples are kept |
| `favorite` | `{"model": "<id>"}` | toggle the daily-driver star |

Errors are `{"error": "<sentence>"}` with 400 (bad input), 403
(cross-origin), 404 (unknown model or action), 409 (another action runs) or
501 (the engine lacks the capability or is remote).

## Downloads

mlx-spy downloads a model from the Hugging Face Hub itself, into
`--model-dir` (`~/.mlx-spy/models` by default) as `<owner>/<name>/`, one
pull at a time from a queue kept in its database. Every file streams into
`<file>.mlx-spy-part` and resumes with a Range request after a cut, a retry, a
cancel or a restart of mlx-spy; LFS files are checked against the Hub's
sha256 before the rename. The engine takes no part in the download; when
a pull completes mlx-spy asks it to rescan its model directory, so the
model appears in the list when that directory is the one the engine
serves. A gated repository needs `hf.key` in the secrets directory.

| Route | Body | Answer |
|---|---|---|
| `GET /api/pulls` | | the last 20 pulls, newest first |
| `POST /api/pulls` | `{repo}`: `owner/name` or a huggingface.co URL | 202, the queued pull; the same repository again resumes its failed or cancelled pull, and answers 409 while one is queued or running |
| `GET /api/pulls/<id>` | | the pull |
| `POST /api/pulls/<id>/cancel` | | the pull, paused: its parts stay on disk and a new POST for the repository resumes it. 409 when it is not queued or running |
| `DELETE /api/pulls/<id>` | | `{ok: true}`; a running pull is stopped first, then its files, partial or finished, and its record are deleted |

A pull is `{id, repo, revision, dir, status, bytesTotal, bytesDone,
filesTotal, filesDone, file, error, createdAt, updatedAt, finishedAt,
speedBps}`. `status` is `queued`, `running`, `done`, `failed` (the reason
in `error`) or `cancelled`. `revision` is the commit the file list was
taken at; every file resolves against it. `file` is the path in flight
and `speedBps` the rate over the last seconds, both only while running.
Errors are 400 (not a repository id), 403 (gated or private, no token),
404 (unknown repository or pull), 409 (see above) or 502 (the Hub did not
answer). A pull that needs more disk than the model directory has free,
plus 1 GB, fails at start with the numbers in `error`.

## Chat

The chat is server-owned: mlx-spy sends the request to the engine, writes
the reply into its database as it streams, and the browser only watches.
One send runs at a time; a second send anywhere answers 409. A send with
tools on can take several engine rounds. Bodies are JSON, at most 256 KB.

| Route | Body | Answer |
|---|---|---|
| `GET /api/chats` | | `[{id, title, model, createdAt, updatedAt, streaming}]`, newest first |
| `POST /api/chats` | `{model, title?, systemPrompt?, thinking?, reasoningEffort?, reasoningHistory?, temperature?, topP?, maxTokens?, toolsOff?, search?}` | 201, the chat; the model must be one the engine lists |
| `GET /api/chats/<id>` | | the chat with its settings and messages in order, a streaming reply included with the text so far |
| `PATCH /api/chats/<id>` | any of `title, model, systemPrompt, thinking, reasoningEffort, reasoningHistory, temperature, topP, maxTokens, toolsOff, search` | the updated chat; `model`, `toolsOff` and `search` answer 409 while the chat has a send running |
| `DELETE /api/chats/<id>` | | `{ok: true}`; a streaming reply is stopped first |
| `POST /api/chats/<id>/messages` | `{content}` | 202 `{user, message}`: the user row and the assistant row that starts streaming |
| `POST /api/chats/<id>/regenerate` | | 202 `{user, message}`; the last reply is dropped and answered again |
| `POST /api/chats/<id>/edit` | `{messageId, content}` | 202 `{user, message}`; that user message and everything after it are replaced |
| `POST /api/chats/<id>/stop` | | `{ok: true}`, also when nothing runs; stops the engine round or the tool call that is running |
| `GET /api/tools` | | `{timezone, tools: [{name, description}]}`, the tool registry and the host timezone of the date line the runner appends to every system prompt |

A message is `{id, chatId, role, content, html, reasoning, status, error,
finishReason, model, createdAt, finishedAt, ttftMs, thinkingMs, stats,
toolCalls, toolCallId, toolName}`. `role` is `user`, `assistant` or `tool`.
`html` is the server-rendered markdown of an assistant row. `status` is
`done`, `streaming`, `stopped` (the stop button), `interrupted` (mlx-spy
was restarted mid-answer) or `error` (the engine's message in `error`); a
tool row also passes through `pending` and `running`. `stats` comes from
the engine's usage chunk: `{promptTokens, cachedTokens, generated,
prefillMs, decodeMs, tokenizeMs}`; the millisecond fields are null on an
engine that reports no timings, and a stopped or failed reply has no
stats. `ttftMs` is measured by mlx-spy from the request to the first token
of any kind, and `thinkingMs` from the first reasoning token to the first
content token.

With tools on, a send is a sequence of rows under the user message: an
assistant row per engine round, with `toolCalls` (`[{id, name,
arguments}]`, `arguments` the JSON string the model wrote) when the round
asked for calls and `finishReason` `tool_calls`, then one `tool` row per
call with `toolCallId`, `toolName` and the result text in `content` (an
error text when the call failed, `[Tool execution was interrupted]` when a
stop or a restart cut it), then the next round. The last assistant row is
the reply. A send that repeats the same call three times in a row ends
with `finishReason` `tool_loop`. A send that hits a limit (rounds, calls,
time or result size) marks that round `tool_limit`, leaves its unrun calls
as interrupted tool rows, and runs one answer round in which no call is
run; the reply is that round, or the `tool_limit` round itself when the
model called a tool anyway.

The runner appends a line with today's date in the host's timezone to
the system prompt of every send, after `systemPrompt` or alone.

Settings live on the chat and apply to the next message. `thinking` maps to
the engine's `enable_thinking`; `reasoningEffort` is `low`, `medium`,
`high`, `none` (an explicit off) or null for the engine default; the sampling fields are null for the
engine defaults. Reasoning is stored; `reasoningHistory` (default true)
sends it back to the engine on later turns as `reasoning_content`, on
every assistant message, so the model rereads its own chain during a
tool loop. Turn it off to keep the engine's prefix cache stable on a
Qwen 3.5 or 3.6 template: those render reasoning only for the turns
after the last user message, so sending it changes how earlier turns
render from one user turn to the next and the engine re-prefills from
the first tool round of the previous turn. `toolsOff` is the list of tool names the
chat does not offer the model; every tool is on when it is empty, and a
name outside the registry is a 400. `search` is the provider `websearch`
uses, `exa` (the default) or `firecrawl`; anything else, null included,
is a 400.

## WebSocket

`WS /ws` sends `{type: "snapshot"}` on connect (the same body as
`/api/snapshot`, plus `chat: {chatId, messageId} | null` naming the row
the send in flight is writing), then `{type: "sample"}` once a second, `{type: "event"}` when
an action finishes in any tab, `{type: "pull"}` with the pull as `data`
on every change of a download's state and twice a second while one runs,
and `{type: "chat"}` for the chat:

| `data.kind` | Fields | When |
|---|---|---|
| `started` | `chat, user, message, deletedFrom?` | a send started; both rows are new. After a regenerate or an edit, `deletedFrom` is the id of the first row that was removed: drop it and every later one |
| `row` | `chatId, message, chat` | one row of a send with tools changed: a later round's streaming row, a round finished with its calls, or a tool row in any state; insert or replace it by id |
| `delta` | `chatId, messageId, content?, contentAt, reasoning?, reasoningAt` | text arrived; `*At` is the length of the buffer before it, so a client applies a delta only when it continues the text it has |
| `html` | `chatId, messageId, html, htmlAt` | at most once a second: the reply rendered up to `htmlAt` characters |
| `done` | `chat, message` | the send ended; `message` is its last assistant row with the terminal status |
| `chat` | `chat` | a chat was created or its title or settings changed |
| `deleted` | `chatId` | a chat was deleted |
