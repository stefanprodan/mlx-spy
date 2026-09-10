// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { h } from "preact";
import { render } from "preact-render-to-string";
import type { ChatWsEvent } from "../../src/chat.ts";
import type { Chat } from "../../src/chats.ts";
import { List } from "../../src/ui/chat/List.tsx";
import {
  onChat,
  open,
  openDraft,
  removeCurrent,
  showDraft,
} from "../../src/ui/chat/nav.ts";
import {
  beginNavigation,
  canSend,
  chats,
  command,
  copy,
  current,
  currentStreaming,
  draft,
  editDraft,
  editor,
  localDrafts,
  note,
  opened,
  patch,
  resetDraft,
  runOf,
  runs,
  send,
  setCurrent,
  setNote,
  setOpen,
  state,
} from "../../src/ui/chat/store.ts";
import { loadRecording } from "./ws.ts";

// The socket recording supplies the real chat settings. The delayed
// HTTP response and unsent drafts are browser-local, not socket events.
async function commandRecording(name: string): Promise<ChatWsEvent[]> {
  const lines: { data?: ChatWsEvent }[] = (
    await Bun.file(new URL(`../fixtures/ws/${name}`, import.meta.url)).text()
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return lines.flatMap(({ data }) => (data ? [data] : []));
}
const recorded = (await commandRecording("navigation-race.ndjson")).flatMap(
  (ev) => (ev.kind === "chat" ? [ev.chat] : []),
);
const reviewEvents = await commandRecording("creation-deletion-races.ndjson");
const deletion = reviewEvents.find((ev) => ev.kind === "deleted")!;
const deletedChat = reviewEvents.flatMap((ev) =>
  ev.kind === "chat" && ev.chat.id === deletion.chatId ? [ev.chat] : [],
)[0];
const started = (await loadRecording("plain.ndjson")).flatMap((line) =>
  "type" in line && line.type === "chat" && line.data.kind === "started"
    ? [line.data]
    : [],
)[0];
let sequence = 0;
function chat(index = 0): Chat {
  return {
    ...recorded[index],
    id: `commands-${++sequence}`,
    messages: [],
  };
}
const slot = (
  chatId: string,
  messageId: number,
  phase: "running" | "stopping" = "running",
) => ({ chatId, firstMessageId: messageId, messageId, phase });
function select(value: Chat) {
  beginNavigation();
  setCurrent(value);
  runs.value ??= { limit: 1, sends: [] };
}
function newDraft() {
  beginNavigation();
  runs.value ??= { limit: 1, sends: [] };
  resetDraft();
  state.value = null;
  draft.value = { ...recorded[0] };
}

const originalHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
const preconnect = globalThis.fetch.preconnect;
const fetcher = (
  run: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
) => Object.assign(run, { preconnect });

beforeEach(() => {
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: { pushState: mock(), replaceState: mock() },
  });
});

afterEach(() => {
  mock.restore();
  if (originalHistory) {
    Object.defineProperty(globalThis, "history", originalHistory);
  } else Reflect.deleteProperty(globalThis, "history");
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else Reflect.deleteProperty(navigator, "clipboard");
  state.value = null;
  runs.value = null;
  chats.value = [];
  resetDraft(false);
  localDrafts.value = [];
});

describe("chat command ownership", () => {
  test("a delayed copy failure stays with its originating chat", async () => {
    const a = chat();
    const b = chat(1);
    const result = Promise.withResolvers<void>();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mock(() => result.promise) },
    });
    select(a);
    const copying = copy("A's text");
    select(b);
    setNote("B's note");
    result.reject(new Error("Copy denied"));
    expect(await copying).toBe(false);
    expect(note.value?.text).toBe("B's note");
    select(a);
    expect(note.value?.text).toBe("Copy denied");
  });

  test("A's delayed rejection preserves B's draft and keeps A's error in A", async () => {
    const a = chat();
    const b = chat(1);
    const response = Promise.withResolvers<Response>();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      fetcher(() => response.promise),
    );
    select(a);
    editDraft("A_ORIGINAL_SUBMISSION_DO_NOT_MOVE");
    const pending = send(editor.value.text.value);
    expect(editor.value.pending.value).toBe(1);
    select(b);
    editDraft("B_NEW_DRAFT_MUST_SURVIVE");
    setNote("B's note");
    response.resolve(Response.json({ error: "A rejected" }, { status: 409 }));
    expect(await pending).toBe(false);
    expect(current.value?.id).toBe(b.id);
    expect(editor.value.text.value).toBe("B_NEW_DRAFT_MUST_SURVIVE");
    expect(note.value?.text).toBe("B's note");
    select(a);
    expect(editor.value.text.value).toBe("A_ORIGINAL_SUBMISSION_DO_NOT_MOVE");
    expect(note.value?.text).toBe("A rejected");
    expect(editor.value.pending.value).toBe(0);
    expect(fetch.mock.calls[0][0]).toBe(`/api/chats/${a.id}/messages`);
  });

  test("acceptance clears only the submitted revision of its own draft", async () => {
    const a = chat();
    const b = chat(1);
    const response = Promise.withResolvers<Response>();
    spyOn(globalThis, "fetch").mockImplementation(
      fetcher(() => response.promise),
    );
    select(a);
    editDraft("submitted");
    const pending = send("submitted");
    editDraft("new text while waiting");
    select(b);
    editDraft("B");
    response.resolve(Response.json({}));
    expect(await pending).toBe(true);
    expect(editor.value.text.value).toBe("B");
    select(a);
    expect(editor.value.text.value).toBe("new text while waiting");
    const next = send("new text while waiting");
    expect(await next).toBe(true);
    expect(editor.value.text.value).toBe("");
  });

  test("a rejected send does not overwrite newer typing in the same chat", async () => {
    const response = Promise.withResolvers<Response>();
    spyOn(globalThis, "fetch").mockImplementation(
      fetcher(() => response.promise),
    );
    select(chat());
    editDraft("first");
    const pending = send("first");
    editDraft("revised");
    response.resolve(Response.json({ error: "rejected" }, { status: 409 }));
    await pending;
    expect(editor.value.text.value).toBe("revised");
    expect(note.value?.text).toBe("rejected");
  });

  test("duplicate submissions cannot create two pending requests", async () => {
    const response = Promise.withResolvers<Response>();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      fetcher(() => response.promise),
    );
    select(chat());
    editDraft("first");
    const pending = send("first");
    expect(await send("first")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    response.resolve(Response.json({}));
    expect(await pending).toBe(true);
  });

  test("a delayed create sends to its returned ID without selecting over B", async () => {
    const created = chat();
    const b = chat(1);
    const create = Promise.withResolvers<Response>();
    const fetch = spyOn(globalThis, "fetch")
      .mockImplementationOnce(fetcher(() => create.promise))
      .mockResolvedValue(Response.json({}));
    newDraft();
    editDraft("from new chat");
    const origin = editor.value;
    const pending = send("from new chat");
    select(b);
    editDraft("B");
    create.resolve(Response.json(created));
    expect(await pending).toBe(true);
    expect(current.value?.id).toBe(b.id);
    expect(editor.value.text.value).toBe("B");
    expect(origin.text.value).toBe("");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/chats",
      `/api/chats/${created.id}/messages`,
    ]);
  });

  test("a delayed create cannot replace a newer uncreated draft", async () => {
    const created = chat();
    const create = Promise.withResolvers<Response>();
    spyOn(globalThis, "fetch")
      .mockImplementationOnce(fetcher(() => create.promise))
      .mockResolvedValue(
        Response.json({ error: "send rejected" }, { status: 409 }),
      );
    newDraft();
    editDraft("original");
    const origin = editor.value;
    const pending = send("original");
    newDraft();
    editDraft("new draft");
    create.resolve(Response.json(created));
    expect(await pending).toBe(false);
    expect(current.value).toBeNull();
    expect(editor.value.text.value).toBe("new draft");
    expect(note.value).toBeNull();
    select(created);
    expect(editor.value).toBe(origin);
    expect(editor.value.text.value).toBe("original");
    expect(note.value?.text).toBe("send rejected");
    expect(localDrafts.value.some((d) => d.editor === origin)).toBe(false);
  });

  test("failed creation remains reachable after New chat, with its settings", async () => {
    const create = Promise.withResolvers<Response>();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      fetcher(() => create.promise),
    );
    newDraft();
    draft.value = { ...draft.value, temperature: 0.3 };
    editDraft("original unsaved message");
    const origin = editor.value;
    const sending = send("original unsaved message");
    showDraft(true);
    editDraft("new unsaved message");
    await patch({ temperature: 0.8 });
    create.resolve(Response.json({ error: "create failed" }, { status: 503 }));
    expect(await sending).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(editor.value.text.value).toBe("new unsaved message");
    expect(note.value).toBeNull();
    expect(localDrafts.value).toHaveLength(1);
    expect(localDrafts.value[0].editor).toBe(origin);
    const html = render(h(List, { open: true, onPick: () => {} }));
    expect(html).toContain("<h2>Drafts</h2>");
    expect(html).toContain("original unsaved message");
    expect(html).toContain('<span class="w">Unsent</span>');
    openDraft(localDrafts.value[0]);
    expect(current.value).toBeNull();
    expect(editor.value.text.value).toBe("original unsaved message");
    expect(note.value?.text).toBe("create failed");
    expect(editor.value.pending.value).toBe(0);
    expect(draft.value.temperature).toBe(0.3);
    expect(localDrafts.value).toHaveLength(2);

    const created = chat();
    fetch
      .mockResolvedValueOnce(Response.json(created))
      .mockResolvedValueOnce(Response.json({}));
    expect(await send(editor.value.text.value)).toBe(true);
    expect(current.value?.id).toBe(created.id);
    expect(localDrafts.value).toHaveLength(1);
    openDraft(localDrafts.value[0]);
    expect(editor.value.text.value).toBe("new unsaved message");
    expect(draft.value.temperature).toBe(0.8);
    expect(note.value).toBeNull();
  });

  test("multiple failed creations remain distinct regardless of response order", async () => {
    const first = Promise.withResolvers<Response>();
    const second = Promise.withResolvers<Response>();
    spyOn(globalThis, "fetch")
      .mockImplementationOnce(fetcher(() => first.promise))
      .mockImplementationOnce(fetcher(() => second.promise));
    newDraft();
    editDraft("first");
    const sendingFirst = send("first");
    showDraft(true);
    await patch({ model: recorded[0].model });
    editDraft("second");
    const sendingSecond = send("second");
    showDraft(true);
    editDraft("third");
    second.resolve(Response.json({ error: "second failed" }, { status: 503 }));
    first.resolve(Response.json({ error: "first failed" }, { status: 503 }));
    expect(await sendingFirst).toBe(false);
    expect(await sendingSecond).toBe(false);
    expect(editor.value.text.value).toBe("third");
    expect(localDrafts.value).toHaveLength(2);
    for (const value of localDrafts.value) {
      openDraft(value);
      expect(note.value?.text).toBe(`${editor.value.text.value} failed`);
      expect(editor.value.pending.value).toBe(0);
    }
    expect(localDrafts.value).toHaveLength(3);
  });

  test("reselecting a local draft keeps its latest settings and error", async () => {
    newDraft();
    editDraft("unsent");
    showDraft(true);
    const saved = localDrafts.value[0];
    openDraft(saved);
    await patch({ temperature: 0.6 });
    setNote("retry failed");
    openDraft(saved);
    expect(draft.value.temperature).toBe(0.6);
    expect(note.value?.text).toBe("retry failed");
    expect(localDrafts.value).toHaveLength(1);
  });

  test("a cleared archived draft retains settings changed before leaving it", async () => {
    newDraft();
    await patch({ temperature: 0.3 });
    editDraft("unsent");
    showDraft(true);
    openDraft(localDrafts.value[0]);
    editDraft("");
    await patch({ temperature: 0.6 });
    showDraft(true);
    expect(localDrafts.value).toHaveLength(1);
    openDraft(localDrafts.value[0]);
    expect(editor.value.text.value).toBe("");
    expect(draft.value.temperature).toBe(0.6);
  });

  test("opening the created chat before its response retains the original submission", async () => {
    const created = chat();
    const create = Promise.withResolvers<Response>();
    const message = Promise.withResolvers<Response>();
    const sendingMessage = Promise.withResolvers<void>();
    spyOn(globalThis, "fetch")
      .mockImplementationOnce(fetcher(() => create.promise))
      .mockImplementationOnce(
        fetcher(() => {
          sendingMessage.resolve();
          return message.promise;
        }),
      );
    newDraft();
    editDraft("original submission");
    const origin = editor.value;
    const sending = send("original submission");
    // A creation event makes the chat selectable before POST responds.
    chats.value = [created];
    select(created);
    const selected = editor.value;
    create.resolve(Response.json(created));
    await sendingMessage.promise;
    expect(editor.value).toBe(selected);
    expect(editor.value.text.value).toBe("original submission");
    expect(editor.value.pending.value).toBe(1);
    expect(origin.pending.value).toBe(0);
    message.resolve(Response.json({ error: "send rejected" }, { status: 409 }));
    expect(await sending).toBe(false);
    select(chat(1));
    select(created);
    expect(editor.value.text.value).toBe("original submission");
    expect(note.value?.text).toBe("send rejected");
    expect(editor.value.pending.value).toBe(0);
  });

  test("adopting an already-open editor does not replace or clear newer typing", async () => {
    const created = chat();
    const create = Promise.withResolvers<Response>();
    spyOn(globalThis, "fetch")
      .mockImplementationOnce(fetcher(() => create.promise))
      .mockResolvedValue(Response.json({}));
    newDraft();
    editDraft("submitted");
    const sending = send("submitted");
    select(created);
    editDraft("newer draft in created chat");
    create.resolve(Response.json(created));
    expect(await sending).toBe(true);
    expect(editor.value.text.value).toBe("newer draft in created chat");
    expect(editor.value.pending.value).toBe(0);
  });

  test("navigation already in flight prevents a create response from taking selection", async () => {
    const created = chat();
    const b = chat(1);
    const create = Promise.withResolvers<Response>();
    const reading = Promise.withResolvers<Response>();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      fetcher((url) => {
        if (url === "/api/chats") return create.promise;
        if (url === `/api/chats/${b.id}`) return reading.promise;
        if (url === `/api/chats/${created.id}/messages`) {
          return Promise.resolve(Response.json({}));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    newDraft();
    editDraft("original");
    const sending = send("original");
    const navigating = open(b.id, false);
    create.resolve(Response.json(created));
    expect(await sending).toBe(true);
    expect(current.value).toBeNull();
    reading.resolve(Response.json(b));
    await navigating;
    expect(current.value?.id).toBe(b.id);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test("an unchanged new draft selects its created chat and clears on acceptance", async () => {
    const created = chat();
    const pushState = mock();
    Object.defineProperty(globalThis, "history", {
      configurable: true,
      value: { pushState },
    });
    spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(created))
      .mockResolvedValueOnce(Response.json({}));
    newDraft();
    editDraft("hello");
    const origin = editor.value;
    expect(await send("hello")).toBe(true);
    expect(current.value?.id).toBe(created.id);
    expect(editor.value).toBe(origin);
    expect(editor.value.text.value).toBe("");
    expect(pushState).toHaveBeenCalledWith(null, "", `/chat/${created.id}`);
    state.value = null;
    expect(editor.value).not.toBe(origin);
    editDraft("next chat");
    select(created);
    expect(editor.value.text.value).toBe("");
  });

  test("commands and settings failures stay with their original chat", async () => {
    for (const request of [
      () => command("regenerate"),
      () => patch({ temperature: 0.4 }),
    ]) {
      const a = chat();
      const b = chat(1);
      const response = Promise.withResolvers<Response>();
      const fetch = spyOn(globalThis, "fetch").mockImplementation(
        fetcher(() => response.promise),
      );
      select(a);
      const pending = request();
      select(b);
      setNote("B's note");
      response.resolve(Response.json({ error: "A failed" }, { status: 409 }));
      await pending;
      expect(note.value?.text).toBe("B's note");
      select(a);
      expect(note.value?.text).toBe("A failed");
      fetch.mockRestore();
    }
  });

  test("a delayed deletion response does not navigate away from B", async () => {
    const a = chat();
    const b = chat(1);
    const response = Promise.withResolvers<Response>();
    spyOn(globalThis, "fetch").mockImplementation(
      fetcher(() => response.promise),
    );
    chats.value = [a, b];
    select(a);
    const deleting = removeCurrent();
    select(b);
    editDraft("B's draft");
    response.resolve(Response.json({ ok: true }));
    await deleting;
    expect(current.value?.id).toBe(b.id);
    expect(editor.value.text.value).toBe("B's draft");
    expect(chats.value.map((c) => c.id)).toEqual([b.id]);
  });

  test("a deletion event invalidates a stale GET without leaving the selected chat", async () => {
    const a: Chat = { ...deletedChat, messages: [] };
    const b = chat(1);
    const response = Promise.withResolvers<Response>();
    spyOn(globalThis, "fetch").mockImplementation(
      fetcher(() => response.promise),
    );
    chats.value = [a, b];
    select(b);
    editDraft("B's draft");
    setNote("B's note");
    const opening = open(a.id, true);
    onChat({ kind: "chat", chat: { ...a, title: "buffered" } });
    onChat(deletion);
    response.resolve(Response.json(a));
    await opening;
    expect(current.value?.id).toBe(b.id);
    expect(chats.value.map((c) => c.id)).toEqual([b.id]);
    expect(editor.value.text.value).toBe("B's draft");
    expect(note.value?.text).toBe("B's note");
    expect(history.replaceState).toHaveBeenCalledWith(
      null,
      "",
      `/chat/${b.id}`,
    );
    expect(history.pushState).not.toHaveBeenCalled();
  });

  test("a stale deleted GET cannot replace a new draft or surface its rejection", async () => {
    for (const status of [200, 404]) {
      const response = Promise.withResolvers<Response>();
      const fetch = spyOn(globalThis, "fetch").mockImplementation(
        fetcher(() => response.promise),
      );
      newDraft();
      editDraft("unsent");
      const opening = open(deletedChat.id, false);
      onChat(deletion);
      response.resolve(
        Response.json(
          status === 200 ? { ...deletedChat, messages: [] } : { error: "gone" },
          { status },
        ),
      );
      await opening;
      expect(current.value).toBeNull();
      expect(editor.value.text.value).toBe("unsent");
      expect(note.value).toBeNull();
      expect(history.replaceState).toHaveBeenCalledWith(null, "", "/chat");
      fetch.mockRestore();
    }
  });

  test("deleting another chat leaves the pending navigation intact", async () => {
    const a: Chat = { ...deletedChat, messages: [] };
    const b = chat(1);
    const response = Promise.withResolvers<Response>();
    spyOn(globalThis, "fetch").mockImplementation(
      fetcher(() => response.promise),
    );
    newDraft();
    chats.value = [a, b];
    const opening = open(b.id, true);
    onChat(deletion);
    response.resolve(Response.json(b));
    await opening;
    expect(current.value?.id).toBe(b.id);
    expect(history.pushState).toHaveBeenCalledWith(null, "", `/chat/${b.id}`);
  });

  test("a deleted chat's scheduled gap reload cannot cancel later navigation", async () => {
    const a: Chat = {
      ...deletedChat,
      messages: [{ ...started.message, chatId: deletedChat.id }],
    };
    const b = chat(1);
    select(a);
    onChat({
      kind: "delta",
      chatId: a.id,
      messageId: started.message.id,
      contentAt: 100,
      reasoningAt: 0,
      content: "gap",
    });
    onChat(deletion);
    const response = Promise.withResolvers<Response>();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      fetcher(() => response.promise),
    );
    const opening = open(b.id, true);
    await Bun.sleep(450);
    expect(fetch).toHaveBeenCalledTimes(1);
    response.resolve(Response.json(b));
    await opening;
    expect(current.value?.id).toBe(b.id);
  });

  test("opening a chat preserves its delayed command error and draft", async () => {
    const a = chat();
    select(a);
    editDraft("A's draft");
    setNote("A's rejected send");
    select(chat(1));
    spyOn(globalThis, "fetch").mockResolvedValue(Response.json(a));
    await open(a.id, false);
    expect(current.value?.id).toBe(a.id);
    expect(editor.value.text.value).toBe("A's draft");
    expect(note.value?.text).toBe("A's rejected send");
  });

  test("nothing is sent before the socket's snapshot names the slots", () => {
    const a = chat();
    select(a);
    expect(canSend.value).toBe(true);
    runs.value = null;
    expect(canSend.value).toBe(false);
    runs.value = { limit: 1, sends: [] };
    expect(canSend.value).toBe(true);
  });

  test("a done in another chat leaves this chat's work fold open", () => {
    const a = chat();
    const b = chat(1);
    select(a);
    setOpen(`work-${a.id}-1`, true);
    setOpen(`work-${b.id}-2`, true);
    const finished = { ...started.message, status: "done" as const };
    onChat({ kind: "done", chat: b, message: { ...finished, chatId: b.id } });
    expect(opened.value.has(`work-${a.id}-1`)).toBe(true);
    expect(opened.value.has(`work-${b.id}-2`)).toBe(false);
    onChat({ kind: "done", chat: a, message: { ...finished, chatId: a.id } });
    expect(opened.value.has(`work-${a.id}-1`)).toBe(false);
    opened.value = new Set();
  });

  test("an unsaved terminal failure ends the reply before its slot is released", () => {
    const a = chat();
    runs.value = { limit: 1, sends: [slot(a.id, 1)] };
    chats.value = [{ ...a, streaming: true }];
    select(a);
    expect(currentStreaming.value).toBe(true);
    onChat({
      kind: "error",
      chatId: a.id,
      firstMessageId: 1,
      messageId: 1,
      error: "tool failed (reply could not be saved)",
      content: "",
      reasoning: "",
      html: "",
    });
    // the transcript settles on the receipt; the slot is the server's to
    // free once the cancelled work has drained
    expect(currentStreaming.value).toBe(false);
    expect(state.value?.ended.has(1)).toBe(true);
    expect(runOf(a.id)).not.toBeNull();
    expect(canSend.value).toBe(false);
    expect(chats.value[0].streaming).toBe(false);
    expect(note.value?.text).toBe("tool failed (reply could not be saved)");
    runs.value = { limit: 1, sends: [] };
    expect(canSend.value).toBe(true);
  });

  test("a release while fetching frees the slot without touching the note", async () => {
    const a = chat();
    const b = chat(1);
    runs.value = { limit: 1, sends: [slot(a.id, 1)] };
    select(b);
    setNote("B's note");
    const response = Promise.withResolvers<Response>();
    spyOn(globalThis, "fetch").mockImplementation(
      fetcher(() => response.promise),
    );
    const opening = open(a.id, false);
    onChat({
      kind: "error",
      chatId: a.id,
      firstMessageId: 1,
      messageId: 1,
      error: "tool failed (reply could not be saved)",
      content: "",
      reasoning: "",
      html: "",
    });
    runs.value = { limit: 1, sends: [] };
    expect(canSend.value).toBe(true);
    expect(note.value?.text).toBe("B's note");
    response.resolve(Response.json(a));
    await opening;
    expect(currentStreaming.value).toBe(false);
    expect(state.value?.ended.has(1)).toBe(true);
    expect(note.value?.text).toBe("tool failed (reply could not be saved)");
  });

  test("replaying A's buffered terminal events cannot clear B's newer send", async () => {
    const a = chat();
    const b = chat(1);
    select(b);
    const response = Promise.withResolvers<Response>();
    spyOn(globalThis, "fetch").mockImplementation(
      fetcher(() => response.promise),
    );
    const opening = open(a.id, false);
    runs.value = { limit: 1, sends: [slot(a.id, 1)] };
    onChat({
      ...started,
      chat: a,
      user: null,
      message: { ...started.message, chatId: a.id, id: 1 },
    });
    expect(runOf(a.id)?.phase).toBe("running");
    onChat({
      kind: "error",
      chatId: a.id,
      firstMessageId: 1,
      messageId: 1,
      error: "tool failed (reply could not be saved)",
      content: "",
      reasoning: "",
      html: "",
    });
    runs.value = { limit: 1, sends: [slot(b.id, 2)] };
    onChat({
      ...started,
      chat: b,
      user: null,
      message: { ...started.message, chatId: b.id, id: 2 },
    });
    expect(runOf(b.id)?.phase).toBe("running");
    response.resolve(Response.json(a));
    await opening;
    expect(current.value?.id).toBe(a.id);
    expect(runOf(b.id)?.phase).toBe("running");
    expect(runOf(a.id)).toBeNull();
    expect(currentStreaming.value).toBe(false);
    expect(canSend.value).toBe(false);
  });
});
