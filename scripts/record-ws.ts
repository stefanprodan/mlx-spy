// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Records the chat events mlx-spy pushes on /ws into an ndjson file, one
// line per message with the milliseconds since the first one, so the
// browser client's pure functions can be tested on sequences the runner
// really emitted (plans/26.09.09-preact-plan.md, "Recorded event
// fixtures"). The chat is driven in the browser meanwhile.
//
//   bun scripts/record-ws.ts test/fixtures/ws/plain.ndjson \
//     --note "one message, thinking on" [--seconds 120] \
//     [--reconnect-after 8] [--url ws://127.0.0.1:11236/ws]
//
// `sample` messages are dropped. A `snapshot` is written with only its
// `chat` field (the running send, or null); when that is set the recorder
// does what the page does on connect, GET /api/chats/<id>, and writes the
// answer as a `fetch` line. --reconnect-after closes the socket after that
// many seconds and opens it again, which is what a tab reload does; a close
// by the server (a restart) is written as a `closed` line and followed by
// a reconnect a second later.

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--"));
if (!out) {
  console.error("usage: record-ws.ts <out.ndjson> [--note ...] [--seconds N]");
  process.exit(1);
}
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const url = flag("url") ?? "ws://127.0.0.1:11236/ws";
const http = url.replace(/^ws/, "http").replace(/\/ws$/, "");
const seconds = Number(flag("seconds") ?? 0);
const reconnectAfter = Number(flag("reconnect-after") ?? 0);

const file = Bun.file(out).writer();
let t0: number | null = null;
const write = (line: Record<string, unknown>) => {
  const now = Date.now();
  t0 ??= now;
  file.write(`${JSON.stringify({ t: now - t0, ...line })}\n`);
  file.flush();
};
const note = flag("note");
if (note) write({ note });

let lines = 0;
let ws: WebSocket;
// the chat of the last `started`, fetched after a server-side close so the
// file shows the row the restarted runner left behind (`interrupted`)
let lastChat: string | null = null;
let closed = false;
async function fetchChat(id: string) {
  const res = await fetch(`${http}/api/chats/${id}`);
  write({ fetch: { status: res.status, body: await res.json() } });
}
function connect() {
  ws = new WebSocket(url);
  ws.onopen = () => console.error(`recording ${url} into ${out}`);
  ws.onmessage = async (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.type === "sample") return;
    lines++;
    if (m.type !== "snapshot") {
      write(m);
      if (m.type === "chat" && m.data.kind === "started") {
        lastChat = m.data.chat.id;
      }
      return;
    }
    write({ type: "snapshot", chat: m.data.chat });
    if (m.data.chat) await fetchChat(m.data.chat.chatId);
    else if (closed && lastChat) await fetchChat(lastChat);
    closed = false;
  };
  // the server went away (a restart mid-stream): note it and come back
  // after a second, like the page does after two
  ws.onclose = () => {
    console.error("socket closed, reconnecting");
    write({ closed: true });
    closed = true;
    setTimeout(connect, 1000);
  };
}
connect();

if (reconnectAfter > 0) {
  setTimeout(() => {
    write({ reconnect: true });
    ws.onclose = null;
    ws.close();
    connect();
  }, reconnectAfter * 1000);
}

const stop = () => {
  ws.onclose = null;
  ws.close();
  file.end();
  console.error(`${lines} messages written to ${out}`);
  process.exit(0);
};
process.on("SIGINT", stop);
if (seconds > 0) setTimeout(stop, seconds * 1000);
