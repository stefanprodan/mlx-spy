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
the gear holds the system prompt, temperature, top p and max tokens, all
empty by default so the engine's own defaults apply. Settings live on the
chat and apply to the next message.

Enter sends, Shift+Enter breaks a line. The Send button becomes Stop while
the reply streams. Hover a reply for Copy and Regenerate, a message of your
own for Copy and Edit; editing resends from that point and drops what came
after. Click the title to rename a chat; the first message names it
otherwise. Delete is in the gear.

A reply that was cut shows why under it: `stopped`, `cut at max tokens`,
`interrupted, mlx-spy restarted`, or the engine's error.

## Where it lives

Chats are in the same SQLite file as the history
(`~/.mlx-spy/history.sqlite` by default). Clearing the history keeps them.
There is no retention cap; delete chats by hand.

## Not in this version

Attachments and images, tools, branching, several replies at once.
