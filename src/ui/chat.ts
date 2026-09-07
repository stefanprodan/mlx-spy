// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Chat view. The browser never talks to the engine: it loads chats over
// the REST routes, sends commands (send, stop, regenerate, edit) and watches
// the reply arrive over the shared WebSocket. A reply is text the server
// owns; every delta carries the buffer offset it belongs at, so a tab that
// opened mid-answer (or lost its socket) fetches the row, applies the deltas
// that continue it and drops the ones it already has. Markdown arrives as
// HTML rendered on the server: the page shows that HTML plus the text
// received after it as a plain tail, so a code block in progress never
// breaks out of its element.

import type { ChatWsEvent } from "../chat.ts";
import type { Chat, ChatSettings, ChatSummary, Message } from "../chats.ts";
import type { ModelInfo } from "../engine/types.ts";
import type { Sample } from "../sample.ts";

type Running = { chatId: string; messageId: number } | null;

export type ChatPage = {
  onChat(ev: ChatWsEvent): void;
  // the socket's first message, also after a reconnect
  onSnapshot(models: ModelInfo[], running: Running, reconnect: boolean): void;
  // the model list changed (a load, an eviction) since the snapshot
  onModels(models: ModelInfo[]): void;
  onSample(s: Sample): void;
  onDisconnect(): void;
};

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const MAX_MESSAGE = 256 * 1024;
const CHEVRON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text = "",
) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function button(cls: string, label: string, onclick: () => void) {
  const b = el("button", cls, label);
  b.type = "button";
  b.onclick = onclick;
  return b;
}

// model ids are "<org>/<name>"; the name is enough on a page about one engine
const short = (id: string) => id.slice(id.lastIndexOf("/") + 1);
const GB = 2 ** 30;
const gb = (b: number) => `${(b / GB).toFixed(1)} GB`;
const n = (v: number) => v.toLocaleString("en-US");
const secs = (ms: number) =>
  ms >= 60_000
    ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
    : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
const tps = (tokens: number, ms: number) =>
  ms > 0 ? `${n(Math.round(tokens / (ms / 1000)))} tok/s` : "-";

const fmtClock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const fmtDate = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});

const DAY = 86_400_000;
const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);

// "now", the clock today, the weekday this week, else the date
function when(t: number, now: number): string {
  if (now - t < 60_000) return "now";
  const today = startOfDay(now);
  if (t >= today) return fmtClock.format(t);
  if (t >= today - 6 * DAY) return fmtDay.format(t);
  return fmtDate.format(t);
}

function group(t: number, now: number): string {
  const today = startOfDay(now);
  if (t >= today) return "Today";
  if (t >= today - DAY) return "Yesterday";
  if (t >= today - 6 * DAY) return "This week";
  return "Earlier";
}

const chatIdFromPath = () => {
  const m = /^\/chat\/([^/]+)$/.exec(location.pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
};

async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

// One rendered assistant row while it streams: the buffers as this tab has
// them, the HTML the server last rendered and where the tail starts.
type Live = {
  root: HTMLElement;
  think: HTMLDetailsElement | null;
  md: HTMLElement;
  tail: HTMLElement;
  stats: HTMLElement;
  content: string;
  reasoning: string;
  htmlAt: number;
  // client clocks for the thinking label while it streams; a finished row
  // carries the runner's measurement
  thinkStart: number | null;
  thinkEnd: number | null;
  thinkMs: number | null;
  timer: number | null;
};

export function mountChat(): ChatPage {
  const listEl = $("chat-list");
  const chatsEl = $("chats");
  const threadEl = $("chat-thread");
  const scrollEl = $("chat-scroll");
  const emptyEl = $("chat-empty");
  const jumpEl = $("chat-jump") as HTMLButtonElement;
  const titleEl = $("chat-title");
  const modelBtn = $("chat-model") as HTMLButtonElement;
  const modelPop = $("chat-models");
  const thinkSeg = $("chat-think");
  const input = $("chat-input") as HTMLTextAreaElement;
  const sendBtn = $("chat-send") as HTMLButtonElement;
  const noteEl = $("chat-note");
  const ctxEl = $("chat-ctx");
  const settings = $("chat-settings") as HTMLDialogElement;

  let chats: ChatSummary[] = [];
  let current: Chat | null = null;
  let models: ModelInfo[] = [];
  let running: Running = null;
  // settings of the chat that does not exist yet (nothing is created until
  // the first message is sent)
  const draft: ChatSettings = {
    model: "",
    systemPrompt: "",
    thinking: true,
    reasoningEffort: null,
    temperature: null,
    topP: null,
    maxTokens: null,
  };
  const live = new Map<number, Live>();
  // events for the chat being fetched, applied once the rows are in
  let pending: ChatWsEvent[] = [];
  let loading: string | null = null;
  let stick = true;
  let lastSample: Sample | null = null;

  const settingsOf = (): ChatSettings => current ?? draft;
  const isStreaming = (chatId: string) => running?.chatId === chatId;
  const currentStreaming = () => current !== null && isStreaming(current.id);

  // ---------- notes ----------

  function note(text: string | null, kind = "") {
    noteEl.hidden = text === null;
    noteEl.textContent = text ?? "";
    noteEl.className = `note ${kind}`.trim();
  }

  function fail(err: unknown) {
    note(err instanceof Error ? err.message : String(err));
  }

  // ---------- chat list ----------

  function renderList() {
    const now = Date.now();
    chatsEl.replaceChildren();
    if (chats.length === 0) {
      chatsEl.append(el("p", "none", "No chats yet."));
      return;
    }
    let lastGroup = "";
    for (const c of chats) {
      const g = group(c.updatedAt, now);
      if (g !== lastGroup) {
        chatsEl.append(el("h2", "", g));
        lastGroup = g;
      }
      const b = el(
        "button",
        `chat-row${c.id === current?.id ? " active" : ""}`,
      );
      b.type = "button";
      b.dataset.id = c.id;
      const m = el("span", "m");
      if (c.streaming) m.append(el("i", "dot"));
      m.append(short(c.model));
      b.append(
        el("span", "t", c.title || "New chat"),
        m,
        el("span", "w", when(c.updatedAt, now)),
      );
      b.onclick = () => {
        listEl.classList.remove("open");
        if (c.id !== current?.id) void open(c.id, true);
      };
      chatsEl.append(b);
    }
  }

  function upsert(c: ChatSummary) {
    chats = [c, ...chats.filter((x) => x.id !== c.id)].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    renderList();
  }

  async function fetchList() {
    try {
      chats = await api<ChatSummary[]>("/api/chats");
      renderList();
    } catch (err) {
      fail(err);
    }
  }

  // ---------- header ----------

  function modelInfo(id: string) {
    return models.find((m) => m.id === id) ?? null;
  }

  function renderHeader() {
    const s = settingsOf();
    titleEl.textContent = current?.title || "New chat";
    document.title = current?.title
      ? `${current.title} · mlx-spy`
      : "mlx-spy · chat";
    const info = s.model ? modelInfo(s.model) : null;
    modelBtn.querySelector(".name")!.textContent = s.model
      ? short(s.model)
      : "pick a model";
    modelBtn.classList.toggle("missing", s.model !== "" && info === null);
    modelBtn.title = info
      ? info.loaded
        ? `${s.model}, loaded`
        : `${s.model}, not loaded`
      : s.model
        ? `${s.model} is not on the engine anymore`
        : "";
    modelBtn.querySelector(".dot")!.className =
      `dot${info?.loaded ? " up" : ""}`;
    for (const b of thinkSeg.querySelectorAll("button")) {
      b.classList.toggle("on", (b.dataset.think === "1") === s.thinking);
    }
    renderComposer();
  }

  async function patch(p: Partial<ChatSettings> & { title?: string }) {
    if (!current) {
      Object.assign(draft, p);
      renderHeader();
      return;
    }
    try {
      const updated = await api<ChatSummary & ChatSettings>(
        `/api/chats/${encodeURIComponent(current.id)}`,
        "PATCH",
        p,
      );
      Object.assign(current, updated);
      renderHeader();
      upsert({ ...updated, streaming: isStreaming(updated.id) });
    } catch (err) {
      fail(err);
    }
  }

  thinkSeg.onclick = (ev) => {
    const b = (ev.target as HTMLElement).closest("button");
    if (b) void patch({ thinking: b.dataset.think === "1" });
  };
  // the title is edited in place; Enter saves, Escape restores
  function editTitle() {
    if (!current) return;
    const inp = document.createElement("input");
    inp.className = "title";
    inp.value = current.title;
    inp.maxLength = 120;
    inp.setAttribute("aria-label", "Chat title");
    titleEl.replaceWith(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      inp.replaceWith(titleEl);
      const title = inp.value.trim();
      if (save && title && title !== current?.title) void patch({ title });
    };
    inp.onkeydown = (ev) => {
      if (ev.key === "Enter") finish(true);
      else if (ev.key === "Escape") finish(false);
    };
    inp.onblur = () => finish(true);
  }
  titleEl.onclick = editTitle;

  // ---------- model picker ----------

  const loadedCount = () => models.filter((m) => m.loaded).length;

  function renderModelPop() {
    modelPop.replaceChildren();
    const s = settingsOf();
    const sorted = [...models].sort(
      (a, b) => Number(b.loaded) - Number(a.loaded) || a.id.localeCompare(b.id),
    );
    for (const m of sorted) {
      const b = el("button", m.id === s.model ? "on" : "");
      b.type = "button";
      b.setAttribute("role", "option");
      const slash = m.id.lastIndexOf("/");
      const id = el("span", "id");
      id.append(
        el("span", "owner", slash > 0 ? `${m.id.slice(0, slash + 1)}` : ""),
        m.id.slice(slash + 1),
      );
      b.append(
        el("span", `dot${m.loaded ? " up" : ""}`),
        id,
        el(
          "span",
          "size",
          m.loaded ? gb(m.bytesResident) : `${gb(m.bytesOnDisk)} on disk`,
        ),
      );
      b.onclick = () => {
        modelPop.hidden = true;
        pickModel(m);
      };
      modelPop.append(b);
    }
    if (models.length === 0) {
      modelPop.append(el("p", "evict", "The engine lists no models."));
    }
  }

  function pickModel(m: ModelInfo) {
    void patch({ model: m.id });
    if (m.loaded) {
      note(null);
      return;
    }
    const evict =
      loadedCount() >= 2
        ? " Two models are resident, so the least recently used one is evicted."
        : "";
    note(
      `${short(m.id)} is not loaded. The first message loads it, which takes a while.${evict}`,
      "info",
    );
  }

  modelBtn.onclick = () => {
    if (modelPop.hidden) renderModelPop();
    modelPop.hidden = !modelPop.hidden;
  };
  document.addEventListener("click", (ev) => {
    if (
      !modelPop.hidden &&
      !modelPop.contains(ev.target as Node) &&
      !modelBtn.contains(ev.target as Node)
    ) {
      modelPop.hidden = true;
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") modelPop.hidden = true;
  });

  // ---------- settings dialog ----------

  const csSystem = $("cs-system") as HTMLTextAreaElement;
  const csEffort = $("cs-effort") as HTMLSelectElement;
  const csTemp = $("cs-temperature") as HTMLInputElement;
  const csTopP = $("cs-top-p") as HTMLInputElement;
  const csMax = $("cs-max-tokens") as HTMLInputElement;
  const csDelete = $("cs-delete") as HTMLButtonElement;
  const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

  $("chat-gear").onclick = () => {
    const s = settingsOf();
    csSystem.value = s.systemPrompt;
    csEffort.value = s.reasoningEffort ?? "";
    csTemp.value = s.temperature === null ? "" : String(s.temperature);
    csTopP.value = s.topP === null ? "" : String(s.topP);
    csMax.value = s.maxTokens === null ? "" : String(s.maxTokens);
    csDelete.hidden = current === null;
    csDelete.textContent = "Delete chat";
    settings.showModal();
  };
  settings.onclose = () => {
    if (settings.returnValue !== "ok") return;
    void patch({
      systemPrompt: csSystem.value,
      reasoningEffort: csEffort.value || null,
      temperature: numOrNull(csTemp.value),
      topP: numOrNull(csTopP.value),
      maxTokens: numOrNull(csMax.value),
    });
  };
  // two clicks, no second dialog: the first arms the button
  csDelete.onclick = () => {
    if (csDelete.textContent !== "Confirm delete") {
      csDelete.textContent = "Confirm delete";
      return;
    }
    settings.close("delete");
    void removeCurrent();
  };

  async function removeCurrent() {
    if (!current) return;
    const id = current.id;
    try {
      await api(`/api/chats/${encodeURIComponent(id)}`, "DELETE");
      chats = chats.filter((c) => c.id !== id);
      showDraft(true);
    } catch (err) {
      fail(err);
    }
  }

  // ---------- transcript ----------

  function stopTimer(v: Live) {
    if (v.timer !== null) clearInterval(v.timer);
    v.timer = null;
  }

  function thinkLabel(v: Live, done: boolean) {
    if (!v.think) return;
    const tl = v.think.querySelector(".tl")!;
    if (done && v.thinkMs !== null) {
      tl.textContent = `Thought for ${secs(v.thinkMs)}`;
      return;
    }
    if (v.thinkStart === null) {
      tl.textContent = done ? "Reasoning" : "Thinking";
      return;
    }
    const end = v.thinkEnd ?? Date.now();
    tl.textContent = `${done || v.thinkEnd !== null ? "Thought" : "Thinking"} for ${secs(end - v.thinkStart)}`;
  }

  function ensureThink(v: Live) {
    if (v.think) return v.think;
    const d = document.createElement("details");
    d.className = "think";
    const s = el("summary");
    s.innerHTML = `<i class="spin" aria-hidden="true"></i>${CHEVRON}<span class="tl">Thinking</span>`;
    d.append(s, el("div", "r"));
    // created by the first reasoning delta, after the row went live
    d.classList.toggle("live", v.timer !== null);
    v.root.prepend(d);
    v.think = d;
    return d;
  }

  function setLive(v: Live, on: boolean) {
    v.think?.classList.toggle("live", on);
    v.tail.hidden = !on;
    if (on && v.timer === null) {
      v.timer = window.setInterval(() => {
        thinkLabel(v, false);
        renderLiveStats(v);
      }, 250);
    }
    if (!on) stopTimer(v);
  }

  function renderBody(v: Live, html: string | null) {
    if (html !== null) v.md.innerHTML = html;
    const tail = v.content.slice(v.htmlAt);
    v.tail.replaceChildren(tail, el("span", "cursor"));
    if (v.think) {
      v.think.querySelector(".r")!.textContent = v.reasoning;
    }
    keepBottom();
  }

  function statsRow(m: Message, last: boolean): HTMLElement {
    const s = el("div", "stats");
    const span = (label: string, value: string, cls = "") => {
      const e = el("span", cls);
      e.append(label ? `${label} ` : "", el("b", "", value));
      return e;
    };
    s.append(el("span", "who", short(m.model ?? "")));
    const st = m.stats;
    if (m.ttftMs !== null) s.append(span("TTFT", secs(m.ttftMs)));
    if (st) {
      s.append(
        span("prefill", tps(st.promptTokens - st.cachedTokens, st.prefillMs)),
        span("decode", tps(st.generated, st.decodeMs)),
      );
      const p = el("span");
      p.append(
        "prompt ",
        el("b", "", n(st.promptTokens)),
        " · cached ",
        el("b", "", n(st.cachedTokens)),
      );
      s.append(p, span("generated", n(st.generated)));
    }
    if (m.finishedAt !== null) {
      s.append(span("", secs(m.finishedAt - m.createdAt)));
    }
    if (m.status === "stopped") s.append(el("span", "st", "stopped"));
    else if (m.status === "interrupted") {
      s.append(el("span", "st", "interrupted, mlx-spy restarted"));
    } else if (m.status === "error") {
      s.append(el("span", "st err", `error: ${m.error ?? "unknown"}`));
    } else if (m.finishReason?.startsWith("length")) {
      s.append(el("span", "st", "cut at max tokens"));
    } else if (m.finishReason?.includes("repetition_loop")) {
      s.append(el("span", "st", "stopped a repetition loop"));
    }
    const acts = el("span", "acts");
    acts.append(
      button("", "Copy", () => void navigator.clipboard.writeText(m.content)),
    );
    if (last) acts.append(button("", "Regenerate", () => void regenerate()));
    s.append(acts);
    return s;
  }

  // live numbers come from the sampler while the reply streams: the engine
  // reports the request's token count and mlx-spy the rate between ticks
  function renderLiveStats(v: Live) {
    const s = v.stats;
    s.replaceChildren(el("span", "who", short(current?.model ?? "")));
    const b = (label: string, value: string) => {
      const e = el("span");
      e.append(`${label} `, el("b", "", value));
      s.append(e);
    };
    const smp = lastSample;
    if (smp && smp.requestsRunning > 0) {
      if (smp.requestsPrefilling > 0 && smp.prefillTps) {
        b("prefill", `${n(Math.round(smp.prefillTps))} tok/s`);
      } else if (smp.decodeTps) {
        b("decode", `${n(Math.round(smp.decodeTps))} tok/s`);
      }
      if (smp.inflightTokens > 0) {
        b("generated", n(smp.inflightTokens));
      }
    }
    const started = v.root.dataset.started;
    if (started) b("", secs(Date.now() - Number(started)));
    if (v.content === "" && v.reasoning === "") {
      s.append(el("span", "", "waiting for the first token"));
    }
  }

  function userRow(m: Message) {
    const d = el("div", "msg user", m.content);
    d.dataset.id = String(m.id);
    const acts = el("span", "uacts");
    acts.append(
      button("", "Copy", () => void navigator.clipboard.writeText(m.content)),
      button("", "Edit", () => editMessage(m, d)),
    );
    d.append(acts);
    return d;
  }

  function editMessage(m: Message, row: HTMLElement) {
    if (currentStreaming()) return;
    row.classList.add("editing");
    const ta = document.createElement("textarea");
    ta.value = m.content;
    ta.rows = Math.min(12, m.content.split("\n").length + 1);
    const actions = el("div", "row");
    const cancel = button("btn", "Cancel", () => {
      row.replaceWith(userRow(m));
    });
    const save = button("btn primary", "Send", () => {
      const content = ta.value.trim();
      if (!content) return;
      void command("edit", { messageId: m.id, content });
    });
    actions.append(cancel, save);
    row.replaceChildren(ta, actions);
    ta.focus();
    ta.onkeydown = (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        save.click();
      } else if (ev.key === "Escape") cancel.click();
    };
  }

  function assistantRow(m: Message, last: boolean): HTMLElement {
    const root = el("div", "msg assistant");
    root.dataset.id = String(m.id);
    root.dataset.started = String(m.createdAt);
    const md = el("div", "md");
    md.innerHTML = m.html ?? "";
    const tail = el("div", "tail");
    tail.hidden = true;
    const stats = el("div", "stats");
    root.append(md, tail, stats);
    const v: Live = {
      root,
      think: null,
      md,
      tail,
      stats,
      content: m.content,
      reasoning: m.reasoning,
      htmlAt: m.content.length,
      thinkStart: null,
      thinkEnd: null,
      thinkMs: m.thinkingMs,
      timer: null,
    };
    if (m.reasoning) {
      ensureThink(v);
      v.think!.querySelector(".r")!.textContent = m.reasoning;
    }
    if (m.status === "streaming") {
      live.set(m.id, v);
      // resumed mid-answer: the clock starts at what the row says
      if (m.reasoning && !m.content)
        v.thinkStart = m.createdAt + (m.ttftMs ?? 0);
      setLive(v, true);
      thinkLabel(v, false);
      renderBody(v, null);
      renderLiveStats(v);
    } else {
      thinkLabel(v, true);
      stats.replaceWith(statsRow(m, last));
    }
    return root;
  }

  function renderThread() {
    for (const v of live.values()) stopTimer(v);
    live.clear();
    threadEl.replaceChildren();
    if (!current) {
      emptyEl.hidden = false;
      renderEmpty();
      return;
    }
    emptyEl.hidden = true;
    const msgs = current.messages;
    msgs.forEach((m, i) => {
      threadEl.append(
        m.role === "user" ? userRow(m) : assistantRow(m, i === msgs.length - 1),
      );
    });
    stick = true;
    scrollEl.scrollTop = scrollEl.scrollHeight;
    jumpEl.hidden = true;
    renderContext();
  }

  function renderEmpty() {
    const s = settingsOf();
    emptyEl.replaceChildren();
    const p = el("p");
    if (s.model) {
      p.append("Start a chat with ", el("b", "", short(s.model)));
    } else {
      p.append("Pick a model to start a chat.");
    }
    emptyEl.append(p);
    const info = s.model ? modelInfo(s.model) : null;
    if (info && !info.loaded) {
      emptyEl.append(
        el("small", "", "The model is not loaded; the first message loads it."),
      );
    }
  }

  // the last completed reply's prompt size against the model's window
  function renderContext() {
    const s = settingsOf();
    const info = s.model ? modelInfo(s.model) : null;
    const last = current?.messages
      .slice()
      .reverse()
      .find((m) => m.role === "assistant" && m.stats);
    if (!info?.contextLength || !last?.stats) {
      ctxEl.hidden = true;
      return;
    }
    const used = last.stats.promptTokens + last.stats.generated;
    ctxEl.hidden = false;
    (ctxEl.querySelector(".bar i") as HTMLElement).style.width =
      `${Math.min(100, (used / info.contextLength) * 100).toFixed(1)}%`;
    ctxEl.querySelector(".n")!.textContent =
      `${n(used)} / ${n(info.contextLength)}`;
    ctxEl.title =
      "Context used by the last reply: prompt plus generated tokens";
  }

  function keepBottom() {
    if (stick) scrollEl.scrollTop = scrollEl.scrollHeight;
  }
  scrollEl.addEventListener("scroll", () => {
    const gap =
      scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    stick = gap < 40;
    jumpEl.hidden = gap < 80;
  });
  jumpEl.onclick = () => {
    stick = true;
    scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "smooth" });
  };

  // ---------- streaming ----------

  // regenerate and edit replace rows: drop that row and every later one
  function dropFrom(chatId: string, messageId: number) {
    if (!current || chatId !== current.id) return;
    for (const m of current.messages) {
      if (m.id < messageId) continue;
      const v = live.get(m.id);
      if (v) stopTimer(v);
      live.delete(m.id);
      threadEl.querySelector(`[data-id="${m.id}"]`)?.remove();
    }
    current.messages = current.messages.filter((m) => m.id < messageId);
  }

  function appendMessage(m: Message) {
    if (!current || m.chatId !== current.id) return;
    if (current.messages.some((x) => x.id === m.id)) return;
    current.messages.push(m);
    // the previous reply loses its Regenerate button
    const prev = threadEl.lastElementChild;
    if (prev?.classList.contains("assistant")) {
      prev.querySelector(".acts button:last-child")?.remove();
    }
    threadEl.append(m.role === "user" ? userRow(m) : assistantRow(m, true));
    stick = true;
    keepBottom();
  }

  function applyDelta(ev: Extract<ChatWsEvent, { kind: "delta" }>) {
    const v = live.get(ev.messageId);
    if (!v) return;
    let gap = false;
    if (ev.reasoning !== undefined) {
      if (ev.reasoningAt === v.reasoning.length) {
        if (v.reasoning === "") v.thinkStart = Date.now();
        ensureThink(v);
        v.reasoning += ev.reasoning;
      } else if (ev.reasoningAt > v.reasoning.length) gap = true;
    }
    if (ev.content !== undefined) {
      if (ev.contentAt === v.content.length) {
        if (v.content === "" && v.thinkStart !== null && v.thinkEnd === null) {
          v.thinkEnd = Date.now();
          thinkLabel(v, false);
        }
        v.content += ev.content;
      } else if (ev.contentAt > v.content.length) gap = true;
    }
    if (gap && current) {
      // a delta ahead of the text: the socket dropped some. The row in the
      // DB may lag the runner's buffer by one throttle window, so reload
      // after it, once per gap
      if (loading === null) {
        loading = current.id;
        const id = current.id;
        setTimeout(() => void open(id, false), 400);
      }
      return;
    }
    renderBody(v, null);
  }

  function applyHtml(ev: Extract<ChatWsEvent, { kind: "html" }>) {
    const v = live.get(ev.messageId);
    // an event buffered before the fetch must not move the boundary back
    if (!v || ev.htmlAt > v.content.length || ev.htmlAt < v.htmlAt) return;
    v.htmlAt = ev.htmlAt;
    renderBody(v, ev.html);
  }

  function finish(m: Message) {
    const v = live.get(m.id);
    live.delete(m.id);
    if (!current || m.chatId !== current.id) return;
    const i = current.messages.findIndex((x) => x.id === m.id);
    if (i === -1) current.messages.push(m);
    else current.messages[i] = m;
    if (v) {
      stopTimer(v);
      if (v.thinkEnd === null) v.thinkEnd = Date.now();
      const row = assistantRow(m, true);
      // keep the measured thinking time on the finished row
      const nv: Live = {
        ...v,
        root: row,
        think: row.querySelector("details"),
      };
      thinkLabel(nv, true);
      if (v.think?.open && nv.think) nv.think.open = true;
      v.root.replaceWith(row);
    } else {
      threadEl
        .querySelector(`[data-id="${m.id}"]`)
        ?.replaceWith(assistantRow(m, true));
    }
    keepBottom();
    renderContext();
  }

  function onChat(ev: ChatWsEvent) {
    if (loading !== null) {
      const id = "chatId" in ev ? ev.chatId : "chat" in ev ? ev.chat.id : null;
      if (id === loading) {
        pending.push(ev);
        return;
      }
    }
    switch (ev.kind) {
      case "started":
        running = { chatId: ev.chat.id, messageId: ev.message.id };
        upsert(ev.chat);
        if (ev.deletedFrom !== undefined) dropFrom(ev.chat.id, ev.deletedFrom);
        appendMessage(ev.user);
        appendMessage(ev.message);
        renderComposer();
        break;
      case "delta":
        applyDelta(ev);
        break;
      case "html":
        applyHtml(ev);
        break;
      case "done":
        if (running?.messageId === ev.message.id) running = null;
        upsert(ev.chat);
        finish(ev.message);
        renderComposer();
        break;
      case "chat":
        upsert({ ...ev.chat, streaming: isStreaming(ev.chat.id) });
        if (current && ev.chat.id === current.id) {
          Object.assign(current, ev.chat);
          renderHeader();
        }
        break;
      case "deleted":
        chats = chats.filter((c) => c.id !== ev.chatId);
        if (current?.id === ev.chatId) showDraft(true);
        else renderList();
        break;
    }
  }

  // ---------- composer ----------

  function renderComposer() {
    const s = settingsOf();
    const mine = currentStreaming();
    const elsewhere = running !== null && !mine;
    sendBtn.classList.toggle("stop", mine);
    sendBtn.setAttribute("aria-label", mine ? "Stop" : "Send");
    const info = s.model ? modelInfo(s.model) : null;
    const ready = info !== null && !elsewhere;
    sendBtn.disabled = !mine && !ready;
    input.disabled = elsewhere;
    input.placeholder = elsewhere
      ? `Answering in ${chats.find((c) => c.id === running?.chatId)?.title || "another chat"}`
      : info
        ? `Message ${short(s.model)}`
        : s.model
          ? `${short(s.model)} is not on the engine; pick a model`
          : "Pick a model";
    for (const b of threadEl.querySelectorAll<HTMLButtonElement>(
      ".acts button, .uacts button",
    )) {
      if (b.textContent !== "Copy") b.disabled = running !== null;
    }
  }

  function grow() {
    input.style.height = "auto";
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
  }
  input.oninput = grow;

  async function command(
    action: "messages" | "regenerate" | "edit" | "stop",
    body?: unknown,
  ) {
    if (!current) return;
    try {
      note(null);
      await api(
        `/api/chats/${encodeURIComponent(current.id)}/${action}`,
        "POST",
        body ?? {},
      );
    } catch (err) {
      fail(err);
    }
  }

  async function send() {
    const content = input.value.trim();
    if (!content) return;
    if (content.length > MAX_MESSAGE) {
      note("The message is too long; 256 KB is the limit.");
      return;
    }
    const s = settingsOf();
    if (!s.model) {
      note("Pick a model first.");
      return;
    }
    input.value = "";
    grow();
    try {
      note(null);
      if (!current) {
        const chat = await api<Chat>("/api/chats", "POST", { ...draft });
        current = chat;
        history.pushState(null, "", `/chat/${encodeURIComponent(chat.id)}`);
        upsert({ ...chat, streaming: false });
        renderHeader();
        renderThread();
      }
      await api(
        `/api/chats/${encodeURIComponent(current.id)}/messages`,
        "POST",
        { content },
      );
    } catch (err) {
      input.value = content;
      grow();
      fail(err);
    }
  }

  async function regenerate() {
    if (currentStreaming()) return;
    await command("regenerate");
  }

  sendBtn.onclick = () => {
    if (currentStreaming()) void command("stop");
    else void send();
  };
  input.onkeydown = (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      if (!sendBtn.disabled && !currentStreaming()) void send();
    }
  };

  // ---------- navigation ----------

  // a slower fetch from an earlier navigation must not win over a later one
  let opening = 0;
  async function open(id: string, push: boolean) {
    const token = ++opening;
    // events buffered for this chat since boot or a gap stay queued
    if (loading !== id) {
      loading = id;
      pending = [];
    }
    try {
      const chat = await api<Chat>(`/api/chats/${encodeURIComponent(id)}`);
      if (token !== opening) return;
      current = chat;
      if (push) history.pushState(null, "", `/chat/${encodeURIComponent(id)}`);
      note(null);
      renderHeader();
      renderThread();
      renderList();
      const queued = pending;
      loading = null;
      pending = [];
      for (const ev of queued) onChat(ev);
      input.focus();
    } catch (err) {
      if (token !== opening) return;
      loading = null;
      pending = [];
      fail(err);
      // a chat that is gone leaves; a passing failure keeps what is on screen
      if (err instanceof Error && err.message.startsWith("HTTP 404")) {
        showDraft(true);
      } else if (!current) showDraft(false);
    }
  }

  // the model of the newest chat, else the daily driver, else a loaded one
  function defaultModel(): string {
    const last = chats[0]?.model;
    if (last && modelInfo(last)) return last;
    return (
      models.find((m) => m.favorite)?.id ??
      models.find((m) => m.loaded)?.id ??
      models[0]?.id ??
      ""
    );
  }

  function showDraft(push: boolean) {
    current = null;
    if (!draft.model || !modelInfo(draft.model)) draft.model = defaultModel();
    if (push) history.pushState(null, "", "/chat");
    note(null);
    renderHeader();
    renderThread();
    renderList();
    input.focus();
  }

  $("chat-new").onclick = () => {
    listEl.classList.remove("open");
    showDraft(true);
  };
  $("chat-listbtn").onclick = () => listEl.classList.toggle("open");
  window.addEventListener("popstate", () => {
    const id = chatIdFromPath();
    if (id) void open(id, false);
    else showDraft(false);
  });

  // code blocks arrive with a Copy button in their head
  threadEl.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest("button.copy");
    if (!b) return;
    const pre = b.closest(".code")?.querySelector("pre");
    if (!pre) return;
    void navigator.clipboard.writeText(pre.textContent ?? "");
    b.textContent = "Copied";
    setTimeout(() => {
      b.textContent = "Copy";
    }, 1200);
  });

  // ---------- boot ----------

  let booted = false;
  // buffer events for the chat in the URL from the first socket message on
  loading = chatIdFromPath();
  void fetchList().then(() => {
    const id = chatIdFromPath();
    if (!id) loading = null;
    if (id) void open(id, false);
    else if (models.length) showDraft(false);
    booted = true;
  });

  return {
    onChat,
    onSnapshot(list, run, reconnect) {
      models = list;
      running = run;
      if (booted && !current && !draft.model) showDraft(false);
      else renderHeader();
      renderContext();
      // after a reconnect the open chat may have finished or moved on
      if (reconnect && current) void open(current.id, false);
    },
    onModels(list) {
      models = list;
      renderHeader();
      renderContext();
      if (!current) renderEmpty();
    },
    onSample(s) {
      lastSample = s;
    },
    onDisconnect() {
      lastSample = null;
    },
  };
}
