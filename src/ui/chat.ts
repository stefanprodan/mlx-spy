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
import type { ModelInfo, ToolCall } from "../engine/types.ts";
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
// token counts in the composer: 8K, 262K
const k = (v: number) => (v < 1000 ? String(v) : `${Math.round(v / 1000)}K`);
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
  const statsEl = $("chat-stats");
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
    toolsOff: [],
    search: "exa",
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
  const csSearch = $("cs-search") as HTMLSelectElement;
  const csDelete = $("cs-delete") as HTMLButtonElement;
  const csTools = $("cs-tools");
  const csToolsHint = $("cs-tools-hint");
  const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));
  // the registry, fetched once; the dialog lists it with a checkbox each
  let toolsList: { name: string; description: string }[] = [];
  void api<{ name: string; description: string }[]>("/api/tools")
    .then((list) => {
      toolsList = list;
    })
    .catch(() => {});

  function renderToolsGroup(s: ChatSettings) {
    csTools.replaceChildren(el("legend", "", "Tools"));
    csTools.hidden = toolsList.length === 0;
    const off = s.toolsOff ?? [];
    for (const t of toolsList) {
      const l = el("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = t.name;
      cb.checked = !off.includes(t.name);
      l.title = t.description;
      l.append(cb, el("b", "", t.name));
      csTools.append(l);
    }
    // a model list with capabilities that leave out tool use is a hint,
    // not a gate: a plain /v1/models has no capabilities at all
    const info = s.model ? modelInfo(s.model) : null;
    const doubtful =
      info !== null &&
      info.capabilities.length > 0 &&
      !info.capabilities.includes("tool_use");
    csToolsHint.hidden = !doubtful || toolsList.length === 0;
  }

  $("chat-gear").onclick = () => {
    const s = settingsOf();
    renderToolsGroup(s);
    csSystem.value = s.systemPrompt;
    csEffort.value = s.reasoningEffort ?? "";
    csTemp.value = s.temperature === null ? "" : String(s.temperature);
    csTopP.value = s.topP === null ? "" : String(s.topP);
    csMax.value = s.maxTokens === null ? "" : String(s.maxTokens);
    csSearch.value = s.search ?? "exa";
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
      search: csSearch.value === "firecrawl" ? "firecrawl" : "exa",
      toolsOff: [...csTools.querySelectorAll<HTMLInputElement>("input")]
        .filter((cb) => !cb.checked)
        .map((cb) => cb.value),
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
    d.dataset.of = v.root.dataset.id ?? "";
    v.root.prepend(d);
    v.think = d;
    adoptThink(v.root);
    return d;
  }

  // a reply that follows a work group thinks inside it: everything before
  // the answer's first word lives in the fold, as one block per turn
  function adoptThink(row: HTMLElement) {
    const g = row.previousElementSibling;
    if (!isWork(g)) return;
    const think = row.querySelector<HTMLDetailsElement>(
      ":scope > details.think",
    );
    if (think) g.querySelector(".wb")!.append(think);
  }

  function setLive(v: Live, on: boolean) {
    v.think?.classList.toggle("live", on);
    v.tail.hidden = !on;
    if (on && v.timer === null) {
      v.timer = window.setInterval(() => {
        thinkLabel(v, false);
        renderStats();
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

  // the line under a reply: why it was cut, if it was, and the actions;
  // the numbers sit in the composer
  function afterRow(m: Message, last: boolean): HTMLElement {
    const s = el("div", "after");
    if (m.status === "stopped") s.append(el("span", "st", "stopped"));
    else if (m.status === "interrupted") {
      s.append(el("span", "st", "interrupted, mlx-spy restarted"));
    } else if (m.status === "error") {
      s.append(el("span", "st err", `error: ${m.error ?? "unknown"}`));
    } else if (m.finishReason?.startsWith("length")) {
      s.append(el("span", "st", "cut at max tokens"));
    } else if (m.finishReason?.includes("repetition_loop")) {
      s.append(el("span", "st", "stopped a repetition loop"));
    } else if (m.finishReason === "tool_loop") {
      s.append(el("span", "st", "stopped after repeating the same call"));
    } else if (m.finishReason === "tool_limit") {
      s.append(el("span", "st", "tool limit reached"));
    }
    const acts = el("span", "acts");
    if (m.content !== "") {
      acts.append(
        button("", "Copy", () => void navigator.clipboard.writeText(m.content)),
      );
    }
    if (last) acts.append(button("", "Regenerate", () => void regenerate()));
    s.append(acts);
    return s;
  }

  // the numbers line in the composer: the last reply's engine timings, or
  // the live rate the monitor sees while a reply streams here. The line
  // covers the whole send: tokens from every round, time from the first
  function renderStats() {
    statsEl.replaceChildren();
    const b = (label: string, value: string, cls = "") => {
      const e = el("span", cls);
      e.append(label ? `${label} ` : "", el("b", "", value));
      statsEl.append(e);
    };
    if (currentStreaming()) {
      const smp = lastSample;
      if (smp && smp.requestsRunning > 0) {
        if (smp.requestsPrefilling > 0 && smp.prefillTps) {
          b("prefill", `${n(Math.round(smp.prefillTps))} tok/s`);
        } else if (smp.decodeTps) {
          b("decode", `${n(Math.round(smp.decodeTps))} tok/s`);
        }
        if (smp.inflightTokens > 0) b("", `${n(smp.inflightTokens)} tok`);
      }
      const first = current?.messages.find(
        (m) => m.id > (lastUser()?.id ?? 0) && m.role === "assistant",
      );
      if (first) b("", secs(Date.now() - first.createdAt), "x");
      statsEl.hidden = false;
      return;
    }
    const last = lastReply();
    const st = last?.stats;
    if (!last || !st) {
      statsEl.hidden = true;
      return;
    }
    const rounds = sendRows(last).filter((x) => x.role === "assistant");
    const first = rounds[0] ?? last;
    const generated = rounds.reduce(
      (sum, x) => sum + (x.stats?.generated ?? 0),
      0,
    );
    if (typeof st.prefillMs === "number") {
      b("prefill", tps(st.promptTokens - st.cachedTokens, st.prefillMs));
    }
    if (typeof st.decodeMs === "number") {
      b("decode", tps(st.generated, st.decodeMs));
    }
    if (st.promptTokens > 0) {
      b("cache", `${Math.round((st.cachedTokens / st.promptTokens) * 100)}%`);
    }
    b("", `${n(Math.max(generated, st.generated))} tok`, "x");
    if (last.finishedAt !== null) {
      b("", secs(last.finishedAt - first.createdAt), "x");
    }
    statsEl.hidden = false;
  }

  const lastUser = () =>
    current?.messages
      .slice()
      .reverse()
      .find((m) => m.role === "user");
  // the last reply; a stopped or failed one has no numbers and the line
  // hides rather than show an older reply's
  const lastReply = () =>
    current?.messages
      .slice()
      .reverse()
      .find((m) => m.role === "assistant");

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

  // ---------- tool calls ----------

  // the summary line shows one telling argument: the zone, the page, the
  // query
  function shortArg(name: string, args: string): string {
    try {
      const o = JSON.parse(args || "{}") as Record<string, unknown>;
      if (name === "webfetch" && typeof o.url === "string") {
        const u = new URL(o.url);
        return u.host + (u.pathname === "/" ? "" : u.pathname);
      }
      if (name === "websearch" && typeof o.query === "string") {
        return o.query.replace(/\s+/g, " ").trim();
      }
      const v = Object.values(o).find((x) => typeof x === "string");
      return typeof v === "string" ? v : "";
    } catch {
      return "";
    }
  }

  function toolBlock(call: ToolCall): HTMLDetailsElement {
    const d = document.createElement("details");
    d.className = "tool live";
    d.dataset.call = call.id;
    const sum = el("summary");
    sum.innerHTML = `<i class="spin" aria-hidden="true"></i>${CHEVRON}`;
    sum.append(
      el("span", "tn", call.name),
      el("span", "ta", shortArg(call.name, call.arguments)),
      el("span", "td", "pending"),
    );
    let pretty = call.arguments;
    try {
      pretty = JSON.stringify(JSON.parse(call.arguments || "{}"), null, 2);
    } catch {}
    d.append(
      sum,
      el("div", "lbl", "arguments"),
      el("div", "args", pretty),
      el("div", "lbl", "result, untrusted"),
      el("div", "out"),
    );
    return d;
  }

  // a tool row lands in the block of the call it answers
  function fillTool(m: Message, root: ParentNode = threadEl) {
    if (m.toolCallId === null) return;
    const d = root.querySelector<HTMLDetailsElement>(
      `details.tool[data-call="${CSS.escape(m.toolCallId)}"]`,
    );
    if (!d) return;
    const busy = m.status === "pending" || m.status === "running";
    d.classList.toggle("live", busy);
    const td = d.querySelector(".td")!;
    td.classList.toggle("err", m.status === "error");
    td.textContent =
      m.status === "done" && m.finishedAt !== null
        ? secs(m.finishedAt - m.createdAt)
        : m.status;
    d.querySelector(".out")!.textContent = m.content;
    const g = d.closest("details.work");
    if (isWork(g)) workLabel(g);
  }

  function upsertTool(m: Message) {
    if (!current || m.chatId !== current.id) return;
    const i = current.messages.findIndex((x) => x.id === m.id);
    if (i === -1) current.messages.push(m);
    else current.messages[i] = m;
    fillTool(m);
  }

  // ---------- work groups ----------
  // the work before a send's reply (reasoning, tool calls, results) folds
  // into one block, so the transcript reads question, work, answer. While
  // the send runs the block stays shut behind one word, "Working"; it
  // opens on a click and settles when the answer is in

  function workGroup(): HTMLDetailsElement {
    const d = document.createElement("details");
    d.className = "work live";
    const sum = el("summary");
    sum.innerHTML = `<i class="spin" aria-hidden="true"></i>${CHEVRON}<span class="wl">Working</span>`;
    d.append(sum, el("div", "wb"));
    return d;
  }

  function isWork(e: Element | null): e is HTMLDetailsElement {
    return e instanceof HTMLDetailsElement && e.classList.contains("work");
  }

  // a send starts with its group in front of the streaming row, so the
  // status line is there before the first token. With tools on, the row
  // streams inside the group: its text may be a step rather than the
  // answer, and nothing should show and then move. The answer comes out
  // as the reply when the send ends
  function startWork(row: HTMLElement) {
    const prev = row.previousElementSibling;
    let g: HTMLDetailsElement;
    if (isWork(prev)) g = prev;
    else {
      g = workGroup();
      row.before(g);
    }
    g.classList.add("live");
    if (toolsOn()) g.querySelector(".wb")!.append(row);
    else adoptThink(row);
    workLabel(g);
  }

  // a finished round that asked for calls moves into the group before it
  function fold(row: HTMLElement) {
    const inside = row.parentElement?.classList.contains("wb");
    const prev = inside
      ? row.parentElement!.parentElement
      : row.previousElementSibling;
    let g: HTMLDetailsElement;
    if (isWork(prev)) g = prev;
    else {
      g = workGroup();
      row.before(g);
    }
    // a round that wrote text before its calls settled the group early
    if (currentStreaming()) g.classList.add("live");
    const wb = g.querySelector(".wb")!;
    if (!inside) wb.append(row);
    // the round's reasoning may already sit in the group (adopted while
    // the row streamed after it); a folded round keeps its own
    const think =
      row.querySelector(":scope > details.think") ??
      wb.querySelector(`:scope > details.think[data-of="${row.dataset.id}"]`);
    if (think) row.prepend(think);
    // what the round said before calling is the model talking to itself:
    // it goes into the round's reasoning block, after the reasoning
    const md = row.querySelector(":scope > .md");
    if (think && md && md.textContent !== "") think.append(md);
    workLabel(g);
  }

  // whether the chat offers the model any tool
  function toolsOn(): boolean {
    const off = settingsOf().toolsOff ?? [];
    return toolsList.some((t) => !off.includes(t.name));
  }

  // a send that ended on a round with calls (a limit, a stop) has no
  // answer: its calls are work like the rest and go into the group, and
  // the row keeps only its cut reason and the actions
  function foldCalls(row: HTMLElement) {
    const prev = row.previousElementSibling;
    let g: HTMLDetailsElement;
    if (isWork(prev)) g = prev;
    else {
      g = workGroup();
      g.classList.remove("live");
      row.before(g);
    }
    adoptThink(row);
    const wb = g.querySelector(".wb")!;
    for (const t of row.querySelectorAll(":scope > .tools > details.tool")) {
      wb.append(t);
    }
    workLabel(g);
  }

  // the rows of the send a message belongs to, up to that message
  function sendRows(m: Message): Message[] {
    const rows: Message[] = [];
    for (const x of current?.messages ?? []) {
      if (x.id > m.id) break;
      if (x.role === "user") rows.length = 0;
      else rows.push(x);
    }
    return rows;
  }

  function workLabel(g: HTMLDetailsElement) {
    const label = g.querySelector(".wl")!;
    const ids = new Set(
      [...g.querySelectorAll<HTMLElement>(".wb > .msg")].map((r) =>
        Number(r.dataset.id),
      ),
    );
    const all = current?.messages ?? [];
    // the row after the group is a round too when it ended on calls
    const nextId = Number(
      (g.nextElementSibling as HTMLElement | null)?.dataset.id ?? "",
    );
    const nextRow = all.find((x) => x.id === nextId);
    if (nextRow?.toolCalls) ids.add(nextId);
    const rounds = all.filter((x) => ids.has(x.id));
    const callIds = new Set(
      rounds.flatMap((x) => x.toolCalls?.map((c) => c.id) ?? []),
    );
    const tools = all.filter(
      (x) => x.toolCallId !== null && callIds.has(x.toolCallId),
    );
    const finished = tools.filter(
      (x) => x.status === "done" || x.status === "error",
    ).length;
    const count = (k: number) => `${k} tool call${k === 1 ? "" : "s"}`;
    // one word while it runs, with the calls finished so far as a sign
    // of progress; the steps are inside, for a click
    if (g.classList.contains("live")) {
      label.textContent =
        finished > 0 ? `Working · ${count(finished)}` : "Working";
      return;
    }
    if (rounds.length === 0) return;
    const start = Math.min(...rounds.map((x) => x.createdAt));
    let end = Math.max(
      ...[...rounds, ...tools].map((x) => x.finishedAt ?? x.createdAt),
    );
    // the reply's own thinking sits in the fold too
    const replyId = Number(
      (g.nextElementSibling as HTMLElement | null)?.dataset.id ?? "",
    );
    const reply = all.find((x) => x.id === replyId);
    if (reply?.thinkingMs != null) {
      end = Math.max(
        end,
        reply.createdAt + (reply.ttftMs ?? 0) + reply.thinkingMs,
      );
    }
    const failed = tools.filter((x) => x.status === "error").length;
    let text = `Worked for ${secs(end - start)}`;
    if (tools.length > 0) text += ` · ${count(tools.length)}`;
    if (failed > 0) text += `, ${failed} failed`;
    label.textContent = text;
  }

  // the work is over: the group folds shut and shows its total. A group
  // with no rounds in it has nothing to show: it goes, and the reply's own
  // reasoning goes back under the reply
  function settleWork(g: Element | null) {
    if (!isWork(g) || !g.classList.contains("live")) return;
    g.classList.remove("live");
    g.open = false;
    const wb = g.querySelector(".wb")!;
    if (!wb.querySelector(":scope > .msg")) {
      const think = wb.querySelector(":scope > details.think");
      const reply = g.nextElementSibling;
      if (think && reply?.classList.contains("assistant")) reply.prepend(think);
      g.remove();
      return;
    }
    workLabel(g);
  }

  function settleAllWork(exceptLast: boolean) {
    const groups = [...threadEl.querySelectorAll("details.work.live")];
    if (exceptLast) groups.pop();
    for (const g of groups) settleWork(g);
  }

  function assistantRow(m: Message, last: boolean): HTMLElement {
    const root = el("div", "msg assistant");
    root.dataset.id = String(m.id);
    root.dataset.started = String(m.createdAt);
    const md = el("div", "md");
    md.innerHTML = m.html ?? "";
    const tail = el("div", "tail");
    tail.hidden = true;
    const tools = el("div", "tools");
    if (m.toolCalls) {
      const ids = new Set<string>();
      for (const call of m.toolCalls) {
        tools.append(toolBlock(call));
        ids.add(call.id);
      }
      for (const t of current?.messages ?? []) {
        if (t.role === "tool" && t.toolCallId && ids.has(t.toolCallId)) {
          fillTool(t, tools);
        }
      }
    }
    root.append(md, tail, tools);
    const v: Live = {
      root,
      think: null,
      md,
      tail,
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
    } else {
      thinkLabel(v, true);
      root.append(afterRow(m, last));
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
      renderContext();
      return;
    }
    emptyEl.hidden = true;
    const msgs = current.messages;
    msgs.forEach((m, i) => {
      if (m.role === "tool") fillTool(m);
      else if (m.role === "user") threadEl.append(userRow(m));
      else {
        const row = assistantRow(m, i === msgs.length - 1);
        threadEl.append(row);
        // a round with calls is work: folded whole when a later round
        // follows it, its calls alone when the send ended on it
        const next = msgs.slice(i + 1).find((x) => x.role !== "tool");
        if (m.toolCalls !== null && next?.role === "assistant") fold(row);
        else if (m.toolCalls !== null && m.status !== "streaming") {
          foldCalls(row);
        } else if (
          m.status === "streaming" &&
          (m.content === "" || toolsOn())
        ) {
          startWork(row);
        } else adoptThink(row);
      }
    });
    // without tools, a reply that already has text has settled its group
    const streaming = [...live.values()].some((v) => v.content === "");
    settleAllWork(currentStreaming() && (toolsOn() || streaming));
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
    renderStats();
    if (!info?.contextLength || !last?.stats) {
      ctxEl.hidden = true;
      return;
    }
    const used = last.stats.promptTokens + last.stats.generated;
    ctxEl.hidden = false;
    (ctxEl.querySelector(".track i") as HTMLElement).style.width =
      `${Math.min(100, (used / info.contextLength) * 100).toFixed(1)}%`;
    ctxEl.querySelector(".n")!.textContent =
      `${k(used)} / ${k(info.contextLength)}`;
    ctxEl.title = `Context used by the last reply: ${n(used)} of ${n(info.contextLength)} tokens, prompt plus generated`;
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
      threadEl.querySelector(`details.think[data-of="${m.id}"]`)?.remove();
    }
    current.messages = current.messages.filter((m) => m.id < messageId);
    for (const g of threadEl.querySelectorAll("details.work")) {
      if (!g.querySelector(".wb > .msg")) g.remove();
    }
  }

  function appendMessage(m: Message) {
    if (!current || m.chatId !== current.id) return;
    if (m.role === "tool") {
      upsertTool(m);
      return;
    }
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
        // text can only be the answer when no tool can follow it; with
        // tools on, a round may talk before it calls, so the fold stays
        // live and says "Writing" until the send ends
        if (v.content === "" && ev.content !== "" && !toolsOn()) {
          settleWork(v.root.previousElementSibling);
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

  function finish(m: Message, last = true) {
    const v = live.get(m.id);
    live.delete(m.id);
    if (!current || m.chatId !== current.id) return;
    const i = current.messages.findIndex((x) => x.id === m.id);
    if (i === -1) current.messages.push(m);
    else current.messages[i] = m;
    // a think block adopted by a work group is not inside the old row
    threadEl.querySelector(`.wb > details.think[data-of="${m.id}"]`)?.remove();
    if (v) {
      stopTimer(v);
      if (v.thinkEnd === null) v.thinkEnd = Date.now();
      const row = assistantRow(m, last);
      v.root.replaceWith(row);
      adoptThink(row);
      // keep the measured thinking time on the finished row
      const nv: Live = {
        ...v,
        root: row,
        think: threadEl.querySelector(`details.think[data-of="${m.id}"]`),
      };
      thinkLabel(nv, true);
      if (v.think?.open && nv.think) nv.think.open = true;
    } else {
      const old = threadEl.querySelector(`[data-id="${m.id}"]`);
      if (old) {
        const row = assistantRow(m, last);
        old.replaceWith(row);
        adoptThink(row);
      }
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
        if (current?.id === ev.chat.id) {
          const row = threadEl.querySelector<HTMLElement>(
            `[data-id="${ev.message.id}"]`,
          );
          if (row) startWork(row);
        }
        renderComposer();
        renderStats();
        break;
      case "delta":
        applyDelta(ev);
        break;
      case "html":
        applyHtml(ev);
        break;
      case "done": {
        // send-level: the reply may be a later round than the row started
        if (running?.chatId === ev.chat.id) running = null;
        upsert(ev.chat);
        finish(ev.message);
        // a send that ended on a round with calls (a limit, a stop) keeps
        // that row as its reply, outside the work group, its calls inside
        const reply = threadEl.querySelector<HTMLElement>(
          `[data-id="${ev.message.id}"]`,
        );
        const wb = reply?.parentElement;
        if (reply && wb?.classList.contains("wb")) {
          const g = wb.parentElement!;
          g.after(reply);
          adoptThink(reply);
          if (!wb.querySelector(".msg, details.think")) g.remove();
        }
        settleAllWork(false);
        if (reply && ev.message.toolCalls) foldCalls(reply);
        // the total now knows the reply's own thinking time
        const g = reply?.previousElementSibling ?? null;
        if (isWork(g)) workLabel(g);
        renderComposer();
        break;
      }
      case "row": {
        // one row of a send with tools: a new round's streaming row, a
        // finished round with its calls, or a tool row in any state
        upsert(ev.chat);
        const m = ev.message;
        if (m.role === "tool") upsertTool(m);
        else if (!current?.messages.some((x) => x.id === m.id)) {
          appendMessage(m);
          const row = threadEl.querySelector<HTMLElement>(
            `[data-id="${m.id}"]`,
          );
          if (row) startWork(row);
        } else {
          finish(m, false);
          if (m.toolCalls !== null) {
            const row = threadEl.querySelector<HTMLElement>(
              `[data-id="${m.id}"]`,
            );
            if (row) fold(row);
          }
        }
        break;
      }
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

  // a resident model first, so a new chat never cold-loads by accident: the
  // daily driver if loaded, else the newest chat's model if loaded, else any
  // loaded one; with nothing resident the same order without the constraint
  function defaultModel(): string {
    const last = chats[0]?.model;
    const pick = (ok: (m: ModelInfo) => boolean) =>
      models.find((m) => ok(m) && m.favorite)?.id ??
      (last && models.find((m) => ok(m) && m.id === last)?.id) ??
      models.find(ok)?.id;
    return pick((m) => m.loaded) ?? pick(() => true) ?? "";
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
  // phone: the list is a drawer over the conversation; desktop: it folds
  // away and the choice survives a reload
  const frameEl = $("view-chat");
  const phone = matchMedia("(max-width: 760px)");
  try {
    if (localStorage.getItem("chat.list") === "closed") {
      frameEl.classList.add("nolist");
    }
  } catch {}
  $("chat-listbtn").onclick = () => {
    if (phone.matches) {
      listEl.classList.toggle("open");
      return;
    }
    const closed = frameEl.classList.toggle("nolist");
    try {
      localStorage.setItem("chat.list", closed ? "closed" : "open");
    } catch {}
  };
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
      if (currentStreaming()) renderStats();
    },
    onDisconnect() {
      lastSample = null;
    },
  };
}
