# Chat

The Chat page is a chat on the engine mlx-spy monitors, with the numbers
the engine reports shown under every reply.

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
- **The engine's own timings.** Under a reply: time to first token,
  prefill and decode tok/s, prompt and cached tokens, generated tokens and
  the duration, from the engine's usage chunk. While the reply streams the
  line shows the live rate the monitor sees.
- **Reasoning is kept.** Thinking models show their reasoning in a
  collapsed block with the time it took; it is stored and sent back on
  later turns.
- **Tools.** The model can call a small set of tools that run inside
  mlx-spy: `get_current_time` (the clock in any zone) and `fetch` (a web
  page as text). A call shows as a block under the reply with the tool,
  its argument, the time it took and, opened, the arguments and the
  result. Tools run without asking; every tool is on for a new chat and
  the gear lists them with a checkbox each.
- **Nothing extra runs.** Markdown is rendered by Bun on the server; the
  page loads no library and the engine is only called when you send.

## Using it

Pick a model in the header. A new chat starts on a loaded model (the
favorite if it is loaded, else the newest chat's model if loaded, else any
loaded one) so it never cold-loads by accident; only with nothing resident
does it fall back to the favorite or the newest chat's model. Loaded
models come first with their size;
picking one that is not loaded shows a note, and the first message loads
it (evicting the least recently used one when the engine is at its
residency cap). Thinking on or off and the reasoning effort sit next to it;
the gear holds the system prompt, temperature, top p, max tokens and the
tools, the fields empty by default so the engine's own defaults apply.
Settings live on the chat and apply to the next message. The button at the left of the header
folds the chat list away so the conversation takes the whole width (the
page remembers the choice); on a phone it opens the list as a drawer.

Enter sends, Shift+Enter breaks a line. The Send button becomes Stop while
the reply streams. Hover a reply for Copy and Regenerate, a message of your
own for Copy and Edit; editing resends from that point and drops what came
after. Click the title to rename a chat; the first message names it
otherwise. Delete is in the gear.

A reply that was cut shows why under it: `stopped`, `cut at max tokens`,
`interrupted, mlx-spy restarted`, or the engine's error.

## Tools

With any tool on, every send can take several rounds: the model asks for
a call, mlx-spy runs it and sends the result back, and the model answers
or calls again. Each round is its own reply row with its own numbers, and
the calls of a round run at once. A send stops after 8 rounds (the last
one tells the model to answer with text), after 24 calls, after 60 s
spent in tools, or when the model repeats the same call three times in a
row; the row then says so. Stop works during a call as it does during a
reply. A call the model got wrong (an unknown tool, bad arguments) goes
back to it as an error text, so it can correct itself.

The tools go into the prompt, so the first message after a change to the
set re-prefills and every message carries their tokens. With a tool on,
the system prompt also carries today's date; the time itself needs the
tool. Some engines hold the reply while a call forms and send it at once,
so a reply can pause for a few seconds with tools on.

`fetch` reads web pages over http and https, on the internet or on your
own networks (the tailnet and the LAN included). It refuses this host
(`localhost` and loopback addresses) and anything that is not text;
redirects are checked hop by hop, and a page is cut at 2 MB. The engine
is reachable, so a model asked to read it can hit any of its routes. The result comes in slices the model can page through. A fetched
page can carry instructions the model may follow, and its only way out is
another fetch whose URL it composes: mlx-spy sends no credentials, caps
the calls per send, and shows results under an "untrusted" label. There
is no approval step; turn `fetch` off in the gear for a chat that should
not read the web.

## Where it lives

Chats are in the same SQLite file as the history
(`~/.mlx-spy/history.sqlite` by default). Clearing the history keeps them.
There is no retention cap; delete chats by hand.

## Not in this version

Attachments and images, search, branching, several replies at once.
