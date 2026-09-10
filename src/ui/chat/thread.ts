// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tree the transcript renders, computed from the chat's state every
// time. The work before a send's reply (reasoning, tool calls, results)
// folds into one block, so the transcript reads question, work, answer.
// While the send runs the block stays shut behind one word, "Working";
// it opens on a click and settles when the answer is in. Deriving the
// tree from the state instead of moving nodes means a tab that reloads
// mid-send shows the same thing as one that watched every event.

import type { RunningSend } from "../../chat.ts";
import type { Message } from "../../chats.ts";
import type { ToolCall } from "../../engine/types.ts";
import { secs } from "../format.ts";
import type { ChatState } from "./events.ts";
import type { Live } from "./stream.ts";

export type ToolNode = { call: ToolCall; result: Message | null };
export type Round = {
  kind: "round";
  message: Message;
  live: Live | null;
  tools: ToolNode[];
  // a finished round that asked for calls shows the text it wrote before
  // them inside its think block: what the model said before calling is
  // the model talking to itself
  folded: boolean;
};
export type ThinkNode = {
  kind: "think";
  of: number;
  message: Message;
  live: Live | null;
};
export type WorkItem = Round | ThinkNode | ({ kind: "tool" } & ToolNode);
export type Work = {
  kind: "work";
  key: string;
  live: boolean;
  label: string;
  items: WorkItem[];
};
export type Reply = {
  kind: "reply";
  message: Message;
  live: Live | null;
  // the think block renders under the row; false when a group before the
  // reply adopted it
  think: boolean;
  tools: ToolNode[];
  last: boolean;
};
export type UserRow = { kind: "user"; message: Message };
// a summary row: the fold that stands for the rows above it in the next
// request (compaction)
export type SummaryNode = {
  kind: "summary";
  message: Message;
  live: Live | null;
};
export type Node = UserRow | Work | Reply | SummaryNode;

type Send = { user: Message | null; summary?: Message; rows: Message[] };

const count = (k: number) => `${k} tool call${k === 1 ? "" : "s"}`;

// the fold's key in the opened set carries the chat, so a `done` in
// another chat shuts only its own folds (nav.ts)
export const workPrefix = (chatId: string) => `work-${chatId}-`;
const workKey = (chatId: string, send: Send) =>
  `${workPrefix(chatId)}${send.user?.id ?? send.rows[0].id}`;

function workLabel(
  live: boolean,
  rounds: Message[],
  tools: Message[],
  reply: Message | null,
): string {
  const finished = tools.filter(
    (x) => x.status === "done" || x.status === "error",
  ).length;
  // one word while it runs, with the calls finished so far as a sign of
  // progress; the steps are inside, for a click
  if (live) return finished > 0 ? `Working · ${count(finished)}` : "Working";
  if (rounds.length === 0) return "Worked";
  const start = Math.min(...rounds.map((x) => x.createdAt));
  let end = Math.max(
    ...[...rounds, ...tools].map((x) => x.finishedAt ?? x.createdAt),
  );
  // the reply's own thinking sits in the fold too
  if (reply?.thinkingMs != null) {
    end = Math.max(
      end,
      reply.createdAt + (reply.ttftMs ?? 0) + reply.thinkingMs,
    );
  }
  const failed = tools.filter((x) => x.status === "error").length;
  // the calls a limit stopped show as stopped in the fold; the label says
  // why, since the round that hit it has no text of its own
  const limited = rounds.some((x) => x.finishReason === "tool_limit");
  let text = `Worked for ${secs(end - start)}`;
  if (tools.length > 0) text += ` · ${count(tools.length)}`;
  if (failed > 0) text += `, ${failed} failed`;
  if (limited) text += ", tool limit";
  return text;
}

// `run` is this chat's slot from the registry, or null; the send is live
// while it runs and its terminal event has not arrived (the slot is
// released after the `done`, so the receipt in `ended` settles first)
export function groupRows(
  s: ChatState,
  toolsOn: boolean,
  run: RunningSend | null,
): Node[] {
  const sendLive =
    run !== null &&
    run.chatId === s.chat.id &&
    run.phase === "running" &&
    !s.ended.has(run.messageId);
  const results = new Map<string, Message>();
  const sends: Send[] = [];
  for (const m of s.chat.messages) {
    if (m.role === "tool") {
      if (m.toolCallId !== null) results.set(m.toolCallId, m);
    } else if (m.role === "user") sends.push({ user: m, rows: [] });
    else if (m.role === "summary") {
      sends.push({ user: null, summary: m, rows: [] });
    } else {
      if (sends.length === 0) sends.push({ user: null, rows: [] });
      sends[sends.length - 1].rows.push(m);
    }
  }
  const toolsOf = (m: Message): ToolNode[] =>
    (m.toolCalls ?? []).map((call) => ({
      call,
      result: results.get(call.id) ?? null,
    }));
  const liveOf = (m: Message) => s.live.get(m.id) ?? null;

  const nodes: Node[] = [];
  sends.forEach((send, i) => {
    if (send.user) nodes.push({ kind: "user", message: send.user });
    if (send.summary) {
      nodes.push({
        kind: "summary",
        message: send.summary,
        live: liveOf(send.summary),
      });
    }
    if (send.rows.length === 0) return;
    const live = sendLive && i === sends.length - 1;
    // a send with tools streams its rows inside the group: the text may
    // be a step rather than the answer, and nothing should show and then
    // move. The answer comes out as the reply when the send ends
    const inside = live && toolsOn;
    const roundRows = inside ? send.rows : send.rows.slice(0, -1);
    const replyRow = inside ? null : send.rows[send.rows.length - 1];
    const items: WorkItem[] = roundRows.map((m) => ({
      kind: "round",
      message: m,
      live: liveOf(m),
      tools: toolsOf(m),
      folded: m.toolCalls !== null,
    }));
    let reply: Reply | null = null;
    if (replyRow) {
      const v = liveOf(replyRow);
      const reasoning = v?.reasoning ?? replyRow.reasoning;
      const content = v?.content ?? replyRow.content;
      // a send that ended on a round with calls (a limit, a stop) has no
      // answer: its calls are work like the rest and go into the group,
      // and the row keeps only its cut reason and the actions
      const ended = replyRow.toolCalls !== null;
      // before the first token the group is there for the status line
      const grouped = items.length > 0 || ended || (live && content === "");
      if (grouped) {
        if (reasoning !== "") {
          items.push({
            kind: "think",
            of: replyRow.id,
            message: replyRow,
            live: v,
          });
        }
        if (ended) {
          for (const t of toolsOf(replyRow)) items.push({ kind: "tool", ...t });
        }
      }
      reply = {
        kind: "reply",
        message: replyRow,
        live: v,
        think: !grouped && reasoning !== "",
        tools: grouped ? [] : toolsOf(replyRow),
        last: false,
      };
      if (grouped) {
        const rounds = ended ? [...roundRows, replyRow] : roundRows;
        const tools = rounds.flatMap((m) =>
          toolsOf(m).flatMap((t) => (t.result ? [t.result] : [])),
        );
        const on = live && content === "";
        nodes.push({
          kind: "work",
          key: workKey(s.chat.id, send),
          live: on,
          label: workLabel(on, rounds, tools, replyRow),
          items,
        });
      }
      nodes.push(reply);
      return;
    }
    const tools = roundRows.flatMap((m) =>
      toolsOf(m).flatMap((t) => (t.result ? [t.result] : [])),
    );
    nodes.push({
      kind: "work",
      key: workKey(s.chat.id, send),
      live: true,
      label: workLabel(true, roundRows, tools, null),
      items,
    });
  });
  // the last reply keeps Regenerate behind a summary: regenerate drops
  // the summary with the reply
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.kind === "summary") continue;
    if (node.kind === "reply") node.last = true;
    break;
  }
  return nodes;
}
