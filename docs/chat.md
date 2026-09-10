# Chat

The Chat page is a chat on the engine mlx-spy monitors, with the numbers
the engine reports shown in the composer.

## What makes it different

- **Replies survive the tab.** mlx-spy sends the request to the engine and
  writes the reply into its own database as it streams. Close the tab,
  reload, open the same chat on the phone: the reply carries on and the
  page picks it up where it is. Every open tab sees the same reply.
- **Stop works from anywhere, at any point.** During a long prefill or
  mid-sentence, from the composer or from the chat list. The engine
  cancels the request at once and the text written so far is kept. A stop
  during a model load takes effect when the load finishes; the model stays
  loaded.
- **The engine's own timings.** One line above the message box: the last
  reply's prefill and decode tok/s, the cached share of its prompt, the
  tokens it generated and the duration, from the engine's usage chunk;
  under it, the context the last reply used against the model's window.
  While a reply streams the line shows the live rate the monitor sees. A
  phone keeps the two rates and the cache share.
- **Each chat keeps its own place in the prefix cache.** Every request
  carries the chat id as `prompt_cache_key`. An engine that evicts its
  hot cache per workload (mlx-serve 26.9.2 and later) then evicts a
  batch job's own entries before it touches the conversation you are in.
- **Reasoning is kept.** Thinking models show their reasoning in a
  collapsed block with the time it took. It is stored and sent back on
  every assistant message on later turns, so the model rereads its own
  chain during a tool loop. Past reasoning in the gear turns that off
  for a chat: a Qwen 3.5 or 3.6 template drops reasoning before the
  last user message anyway, and sending it changes how earlier turns
  render from one user turn to the next, so the engine re-prefills from
  the first tool round of the previous turn on every new message.
- **Tools.** The model can call a small set of tools that run inside
  mlx-spy: `get_current_time` (the clock in any zone), `webfetch` (a web
  page as text) and `websearch` (a web search). While a send works, one line with a spinner says
  "Working", with the calls finished so far once there are any; a click
  opens it on the steps so far. When the send ends,
  that line becomes the fold of the work
  (the reasoning, what the model said between calls, the calls and their
  results), "Worked for 5.6 s, 2 tool calls"; opened, each call shows its
  argument, the time it took and its result. A send that hits the tool
  limit (rounds, calls, time or result size) gets one more round, told to
  answer, so it still ends with text; the calls that did not run are in
  the fold as stopped and the fold's label ends with "tool limit". A send that ended on a stop has
  no answer: its calls are in the fold and
  the reason stands where the answer would be. Text streams below the line
  as it arrives; with tools on it may still turn out to be a step rather
  than the answer, and then it folds in. Tools run without asking; every tool is on for a new chat and
  the gear lists them with a checkbox each (hover a name for what it
  does).
- **Nothing extra runs.** Markdown is rendered by Bun on the server, and
  a fenced code block is highlighted there too (about forty languages;
  one the server does not know stays plain); the page loads no library
  for it and the engine is only called when you send, or to summarize a
  chat that fills the model's window (see below).
- **Diagrams.** A `mermaid` block is drawn on the server once the reply
  is finished and shown as an image in place of the code (flowchart,
  sequence, state, class, ER and XY charts; Copy still copies the
  source). While the reply streams, and for a diagram the server cannot
  draw (pie, gantt, mindmap, a syntax error), the block stays code.
  The full-screen icon beside Copy opens a larger view with the chat
  title. Zoom in for detail and scroll to pan; Fit shows the whole
  diagram again. Close it with the close button or Escape.

## Using it

Pick a model in the header. A new chat starts on a loaded model (the
favorite if it is loaded, else the newest chat's model if loaded, else any
loaded one) so it never cold-loads by accident; only with nothing resident
does it fall back to the favorite or the newest chat's model. Loaded
models come first with their size;
picking one that is not loaded shows a note, and the first message loads
it (evicting the least recently used one when the engine is at its
residency cap). Thinking on or off and the reasoning effort sit next to it;
the gear holds the system prompt, past reasoning, temperature, top p, max
tokens and the tools, the fields empty by default so the engine's own defaults apply.
The system prompt always ends with a line with today's date in the
host's timezone, under your own text or alone; the empty field shows it.
Settings live on the chat and apply to the next message. The button at the left of the header
folds the chat list away so the conversation takes the whole width (the
page remembers the choice); on a phone it opens the list as a drawer. The
page also remembers the chat last used: opening `/chat` from the header
comes back to it, until New chat or a deletion.

Enter sends, Shift+Enter breaks a line. The Send button becomes Stop while
the reply streams; after a stop the box reads Stopping until the engine
stream and tool calls have let go. One reply runs at a time, so while
another chat answers the box says so and takes text but does not send.
Hover a reply for Copy and Regenerate, a message of your
own for Copy and Edit; editing resends from that point and drops what came
after. Click the title to rename a chat; the first message names it
otherwise. Delete is in the gear.

Code and Mermaid blocks have a copy icon in their header. It copies the
block's source and briefly becomes a checkmark when the copy succeeds.
Copy also works when you open mlx-spy over HTTP on another machine,
where the browser does not expose its Clipboard API.

Unsent text stays with its chat while you navigate within the page. It
clears when the send is accepted, unless you have edited it meanwhile.
A delayed rejection keeps the text and error in the originating chat,
not the one you switched to. These drafts live in the tab, not the
database, and do not survive a page reload. Choosing New chat keeps an
unfinished new conversation under Drafts in the list, including its
settings and any creation error, so you can return to it and retry.

A reply that was cut shows why under it: `stopped`, `cut at max tokens`,
`interrupted, mlx-spy restarted`, or the engine's error.
An unexpected failure during tool execution or while saving its state
ends the send with an error and cancels its unfinished calls; results
already completed are kept.
A new send waits until those cancelled calls have finished unwinding.

A long chat is compacted before it outgrows the model's window. When a
reply leaves less than 20k tokens of the window (the number in the
composer; a quarter of the window on a model with a small one), the
send goes on with one more round that asks the model to
summarize the conversation, thinking off and no tools, and the summary
lands in the transcript as a fold, "Summarized 41k tokens". The next
message is answered from the summary and the turns after it; the rows
above the fold stay on the page but are no longer sent to the engine, so
that reply prefills from scratch once. Type `/compact` in the composer
to summarize a chat on demand. A summary that fails or is stopped is
skipped, and the next reply that fills the window tries again.

## Tools

With any tool on, every send can take several rounds: the model asks for
a call, mlx-spy runs it and sends the result back, and the model answers
or calls again. The calls of a round run at once. The numbers in the composer cover the
whole send: the tokens every round generated and the time from the first
round; while it runs, the rate and the count last seen stay on the line
through a tool call and move on when the next round streams. A send stops after 8 rounds (the last
one tells the model to answer with text), after 24 calls, after 60 s
spent in tools, or when the model repeats the same call three times in a
row; the row then says so. Stop works during a call as it does during a
reply. A call the model got wrong (an unknown tool, bad arguments) goes
back to it as an error text, so it can correct itself. A call the engine
cut short, or one made in the answer round after a limit, shows as "not
run" in the fold and is left out of the next message's context.

The tools go into the prompt, so the first message after a change to the
set re-prefills and every message carries their tokens. The time itself
needs the tool; the date is always in the system prompt. Some engines hold the reply while a call forms and send it at once,
so a reply can pause for a few seconds with tools on.

`webfetch` reads web pages over http and https, on the internet or on your
own networks (the tailnet and the LAN included). It refuses this host
(`localhost` and loopback addresses) and anything that is not text;
redirects are checked hop by hop, and a page is cut at 2 MB. The engine
is reachable, so a model asked to read it can hit any of its routes. The result comes in slices the model can page through. A fetched
page can carry instructions the model may follow, and its only way out is
another fetch whose URL it composes: mlx-spy sends no credentials, caps
the calls per send, and shows results under an "untrusted" label. There
is no approval step; turn `webfetch` off in the gear for a chat that should
not read the web.

`websearch` sends the model's query to a search provider and returns
titles, URLs and excerpts; the model can then `webfetch` a result. The
provider is a chat setting in the gear: **Exa** (the default) answers
with dated page excerpts the model can often answer from without a
fetch; **Firecrawl** answers with a list of titles and short
descriptions to fetch from. The model can limit a search to one site
(`domain`). A send gets three searches; the tool description tells the model so. Both providers are tried without a
key: Exa keyless is its free plan (rate limited), and Firecrawl refuses
some networks keyless with a message the model sees and reports. A key
is a file holding the bare key, read at start: `../secrets/exa.key` and
`../secrets/firecrawl.key` next to the binary (`~/.local/secrets/` for
`make install-bin`, `.preview/secrets/` for the preview); the start log
says which were found. A wrong key shows as "websearch key rejected" on
the first search; a rate limit as "websearch rate limited". The query
leaves this host to the chosen provider, keyless or not, and stays in the
chat's tool rows like any call; search results are page content and are
shown under the same "untrusted" label as fetched pages. Turn
`websearch` off in the gear for a chat that should not search.

## OpenRouter

With an OpenRouter key on disk (`../secrets/openrouter.key` next to the
binary, `.preview/secrets/` from source, read at start like the search
keys), the picker gets a second group, **OpenRouter**, under the engine's
models. Its models come from the Settings page, opened from the button at
the foot of the chat list: paste a model id from openrouter.ai (say
`nvidia/nemotron-3-super-120b-a12b:free`), Check looks it up in
OpenRouter's public catalog and shows its price per million tokens in and
out (or "free"), its context window and whether it supports tools and
reasoning, and Add puts it in the list. The list is in mlx-spy's database
and reaches every open tab. Every time the page opens, the prices and
windows of the saved models are refreshed from the catalog; a model the
catalog no longer lists stays, marked "not in catalog", and a catalog
that does not answer leaves the rows as they were and says so on the
prices line. Remove takes two clicks.

A chat on a hosted model works like any other: the same tools, folds,
compaction and history. What differs:

- The conversation leaves this host: every message, the reasoning, the
  tool results and the system prompt go to OpenRouter and its upstream
  provider, an existing chat's history included the moment its model is
  switched. The empty state and the picker say so. Free models may route
  to providers that log or train on prompts; OpenRouter's account
  settings can restrict that.
- The numbers line shows the tokens, the cost of the send in dollars (or
  "free") and the duration; there are no engine timings and no live rate,
  since the engine's gauges are not this reply's. The cache share appears
  only when the upstream reported cached tokens; most free endpoints do
  not cache and would show a meaningless zero.
- Reasoning arrives when the model streams it, and goes back on later
  turns as OpenRouter's `reasoning` field. The generated count includes
  the reasoning tokens.
- OpenRouter runs many requests at once, so its chats have their own
  cap: `--openrouter-concurrency` (4 by default) of them can answer at
  the same time, while the engine still answers one. A local chat and a
  hosted chat never wait for each other; the composer says "OpenRouter:
  4 chats running" when the hosted cap is full.
- A free endpoint that is rate limited upstream, or a key that is
  rejected, ends the reply with OpenRouter's own message under it; there
  is no automatic retry, Regenerate is the retry. Free models get 20
  requests a minute and 1,000 a day on an account that has bought
  credits (50 a day otherwise).
- No prefix cache key is sent; OpenRouter caches per upstream on its own
  and the cached share on the numbers line is what it reports.

Without a key nothing changes: the Settings page says where the key
goes, and the picker shows only the engine's models.

## Where it lives

Chats and the list of hosted models are in the same SQLite file as the
history (`~/.mlx-spy/history.sqlite` by default). Clearing the history
keeps them. There is no retention cap; delete chats by hand.

## Not in this version

Attachments and images, branching, several replies at once.
