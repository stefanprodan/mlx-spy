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
| `GET /api/snapshot` | the latest sample, the model list, the engine's capabilities and cache budgets, host facts, the action log |
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

## Chat

The chat is server-owned: mlx-spy sends the request to the engine, writes
the reply into its database as it streams, and the browser only watches.
One reply streams at a time; a second send anywhere answers 409. Bodies are
JSON, at most 256 KB.

| Route | Body | Answer |
|---|---|---|
| `GET /api/chats` | | `[{id, title, model, createdAt, updatedAt, streaming}]`, newest first |
| `POST /api/chats` | `{model, title?, systemPrompt?, thinking?, reasoningEffort?, temperature?, topP?, maxTokens?}` | 201, the chat; the model must be one the engine lists |
| `GET /api/chats/<id>` | | the chat with its settings and messages in order, a streaming reply included with the text so far |
| `PATCH /api/chats/<id>` | any of `title, model, systemPrompt, thinking, reasoningEffort, temperature, topP, maxTokens` | the updated chat |
| `DELETE /api/chats/<id>` | | `{ok: true}`; a streaming reply is stopped first |
| `POST /api/chats/<id>/messages` | `{content}` | 202 `{user, message}`: the user row and the assistant row that starts streaming |
| `POST /api/chats/<id>/regenerate` | | 202 `{user, message}`; the last reply is dropped and answered again |
| `POST /api/chats/<id>/edit` | `{messageId, content}` | 202 `{user, message}`; that user message and everything after it are replaced |
| `POST /api/chats/<id>/stop` | | `{ok: true}`, also when nothing runs |

A message is `{id, chatId, role, content, html, reasoning, status, error,
finishReason, model, createdAt, finishedAt, ttftMs, thinkingMs, stats}`. `html` is the
server-rendered markdown of an assistant row. `status` is `done`,
`streaming`, `stopped` (the stop button), `interrupted` (mlx-spy was
restarted mid-answer) or `error` (the engine's message in `error`). `stats`
comes from the engine's usage chunk: `{promptTokens, cachedTokens,
generated, prefillMs, decodeMs, tokenizeMs}`; a stopped or failed reply has
none. `ttftMs` is measured by mlx-spy from the request to the first token, and
`thinkingMs` from the first reasoning token to the first content token.

Settings live on the chat and apply to the next message. `thinking` maps to
the engine's `enable_thinking`; `reasoningEffort` is `low`, `medium`,
`high`, `none` (an explicit off) or null for the engine default; the sampling fields are null for the
engine defaults. Reasoning is stored and sent back to the engine on later
turns as `reasoning_content`.

## WebSocket

`WS /ws` sends `{type: "snapshot"}` on connect (the same body as
`/api/snapshot`, plus `chat: {chatId, messageId} | null` naming the reply
in flight), then `{type: "sample"}` once a second, `{type: "event"}` when
an action finishes in any tab, and `{type: "chat"}` for the chat:

| `data.kind` | Fields | When |
|---|---|---|
| `started` | `chat, user, message, deletedFrom?` | a reply started; both rows are new. After a regenerate or an edit, `deletedFrom` is the id of the first row that was removed: drop it and every later one |
| `delta` | `chatId, messageId, content?, contentAt, reasoning?, reasoningAt` | text arrived; `*At` is the length of the buffer before it, so a client applies a delta only when it continues the text it has |
| `html` | `chatId, messageId, html, htmlAt` | at most once a second: the reply rendered up to `htmlAt` characters |
| `done` | `chat, message` | the reply reached a terminal status, given by `message.status` |
| `chat` | `chat` | a chat was created or its title or settings changed |
| `deleted` | `chatId` | a chat was deleted |
