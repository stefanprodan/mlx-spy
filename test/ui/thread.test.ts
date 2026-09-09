// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { Message } from "../../src/chats.ts";
import type { ToolCall } from "../../src/engine/types.ts";
import { type ChatState, stateOf } from "../../src/ui/chat/events.ts";
import {
  groupRows,
  type Node,
  type Reply,
  type Round,
  type ThinkNode,
  type ToolNode,
  type Work,
} from "../../src/ui/chat/thread.ts";
import {
  type DrivenRecording,
  driveRecording,
  loadRecording,
  type RecordingName,
  recordings,
} from "./ws.ts";

const works = (tree: Node[]): Work[] =>
  tree.filter((node: Node): node is Work => node.kind === "work");
const replies = (tree: Node[]): Reply[] =>
  tree.filter((node: Node): node is Reply => node.kind === "reply");
const rounds = (tree: Node[]): Round[] =>
  works(tree).flatMap((work: Work) =>
    work.items.filter(
      (item: Work["items"][number]): item is Round => item.kind === "round",
    ),
  );
const thinks = (tree: Node[]): ThinkNode[] =>
  works(tree).flatMap((work: Work) =>
    work.items.filter(
      (item: Work["items"][number]): item is ThinkNode => item.kind === "think",
    ),
  );

type ToolItem = { kind: "tool" } & ToolNode;

function toolNodes(tree: Node[]): ToolNode[] {
  return works(tree).flatMap((work: Work) =>
    work.items.flatMap((item: Work["items"][number]) => {
      if (item.kind === "round") return item.tools;
      if (item.kind === "tool") return [item];
      return [];
    }),
  );
}

function count(values: number[], value: number): number {
  return values.filter((candidate) => candidate === value).length;
}

function reasoningOf(row: Reply | Round): string {
  return row.live?.reasoning ?? row.message.reasoning;
}

function assertTree(state: ChatState, tree: Node[], toolsOn: boolean) {
  const expectedRows = state.chat.messages
    .filter((message: Message) => message.role !== "tool")
    .map((message: Message) => message.id)
    .sort((a: number, b: number) => a - b);
  const actualRows = [
    ...tree
      .filter((node) => node.kind === "user")
      .map((node) => node.message.id),
    ...replies(tree).map((reply) => reply.message.id),
    ...rounds(tree).map((round) => round.message.id),
    ...tree
      .filter((node) => node.kind === "summary")
      .map((node) => node.message.id),
  ].sort((a, b) => a - b);
  expect(actualRows).toEqual(expectedRows);
  for (const id of expectedRows) expect(count(actualRows, id)).toBe(1);

  const calls = new Set(
    state.chat.messages.flatMap(
      (message: Message) =>
        message.toolCalls?.map((call: ToolCall) => call.id) ?? [],
    ),
  );
  const expectedTools = state.chat.messages
    .filter(
      (message: Message) =>
        message.role === "tool" &&
        message.toolCallId !== null &&
        calls.has(message.toolCallId),
    )
    .map((message: Message) => message.id)
    .sort((a: number, b: number) => a - b);
  const actualTools = toolNodes(tree)
    .flatMap((tool) => (tool.result ? [tool.result.id] : []))
    .sort((a, b) => a - b);
  expect(actualTools).toEqual(expectedTools);
  for (const id of expectedTools) expect(count(actualTools, id)).toBe(1);

  for (const work of works(tree)) {
    if (work.items.length === 0) {
      const index = tree.indexOf(work);
      const reply = tree[index + 1];
      expect(state.running?.chatId).toBe(state.chat.id);
      expect(toolsOn).toBe(false);
      expect(reply?.kind).toBe("reply");
      if (reply?.kind === "reply") {
        expect(reply.live?.content ?? reply.message.content).toBe("");
      }
    }
    if (work.live) {
      expect(
        work.label === "Working" || work.label.startsWith("Working · "),
      ).toBe(true);
    } else {
      expect(work.label.startsWith("Worked for ")).toBe(true);
    }
  }

  const adopted = thinks(tree);
  for (const think of adopted) {
    const work = works(tree).find((candidate) =>
      candidate.items.includes(think),
    );
    const index = work ? tree.indexOf(work) : -1;
    const reply = tree[index + 1];
    expect(reply?.kind).toBe("reply");
    if (reply?.kind === "reply") {
      expect(think.of).toBe(reply.message.id);
      expect(reply.think).toBe(false);
    }
  }

  for (const row of [...replies(tree), ...rounds(tree)]) {
    const hasReasoning = reasoningOf(row) !== "";
    const adoptedCount = adopted.filter(
      (think) => think.of === row.message.id,
    ).length;
    const ownCount =
      row.kind === "reply"
        ? Number(row.think)
        : Number(hasReasoning && adoptedCount === 0);
    expect(ownCount + adoptedCount).toBe(Number(hasReasoning));
  }

  for (const round of rounds(tree)) {
    expect(round.folded).toBe(round.message.toolCalls !== null);
  }

  tree.forEach((node, index) => {
    if (node.kind !== "reply") return;
    expect(node.last).toBe(index === tree.length - 1);
  });
  if (tree.at(-1)?.kind !== "reply") {
    expect(replies(tree).some((reply) => reply.last)).toBe(false);
  }
}

function treeOf(run: DrivenRecording): Node[] {
  expect(run.state).not.toBeNull();
  return groupRows(run.state!, run.toolsOn);
}

function assertFinalConsistency(run: DrivenRecording) {
  const state = run.state!;
  expect(state.running).toBeNull();
  const tree = groupRows(state, run.toolsOn);
  for (const row of [...replies(tree), ...rounds(tree), ...thinks(tree)]) {
    expect(row.live).toBeNull();
  }
  const fresh = stateOf({ ...state.chat, messages: state.chat.messages }, null);
  expect(tree).toEqual(groupRows(fresh, run.toolsOn));
}

async function drive(
  name: RecordingName,
  initial?: ChatState,
): Promise<DrivenRecording> {
  return driveRecording(name, await loadRecording(name), { initial });
}

describe("chat thread recording invariants", () => {
  test("all recordings preserve the tree invariants after every event", async () => {
    const tools = await drive("tools.ndjson");
    const seeded = new Map<RecordingName, ChatState>([
      ["second-turn.ndjson", tools.state!],
    ]);

    for (const name of recordings) {
      const run =
        name === "tools.ndjson" ? tools : await drive(name, seeded.get(name));
      for (const step of run.steps) {
        const tree = groupRows(step.state, run.toolsOn);
        assertTree(step.state, tree, run.toolsOn);
        if (
          "type" in step.line &&
          step.line.type === "chat" &&
          step.line.data.kind === "done" &&
          step.line.data.chat.id === step.state.chat.id
        ) {
          const last = tree.at(-1);
          expect(["reply", "summary"]).toContain(last?.kind ?? "");
          if (last?.kind === "reply") {
            expect(last.message.id).toBe(step.line.data.message.id);
          }
        }
      }
      assertFinalConsistency(run);
    }
  });

  test("plain drops its empty work group on the first content delta", async () => {
    const run = await drive("plain.ndjson");
    const step = run.steps.find(
      (candidate) =>
        "type" in candidate.line &&
        candidate.line.type === "chat" &&
        candidate.line.data.kind === "delta" &&
        Boolean(candidate.line.data.content),
    );
    expect(step).toBeDefined();
    expect(works(groupRows(step!.state, run.toolsOn))).toHaveLength(0);
  });

  test("tools settles its two calls and leaves its reply outside", async () => {
    const run = await drive("tools.ndjson");
    const tree = treeOf(run);
    const work = works(tree);
    expect(work).toHaveLength(1);
    expect(work[0].live).toBe(false);
    const names = toolNodes(tree).map((tool) => tool.call.name);
    // one call each; a tool row is pushed three times (pending, running,
    // done) and lands in the one node of its call
    expect(names.filter((name) => name === "websearch")).toHaveLength(1);
    expect(names.filter((name) => name === "webfetch")).toHaveLength(1);
    expect(tree.at(-1)?.kind).toBe("reply");
  });

  test("stop leaves a stopped reply and no unused work group", async () => {
    const tree = treeOf(await drive("stop.ndjson"));
    expect(works(tree)).toHaveLength(0);
    expect(replies(tree).at(-1)?.message.status).toBe("stopped");
  });

  test("a stop after a tool round keeps the finished round as work", async () => {
    const tree = treeOf(await drive("tools-stop-round.ndjson"));
    expect(replies(tree).at(-1)?.message.status).toBe("stopped");
    const finishedWebfetch = rounds(tree).some((round: Round) =>
      round.tools.some(
        (tool: ToolNode) =>
          tool.call.name === "webfetch" && tool.result?.status === "done",
      ),
    );
    expect(finishedWebfetch).toBe(true);
  });

  test("a stop during a call folds the stopped tool under the reply", async () => {
    const tree = treeOf(await drive("tools-stop-call.ndjson"));
    const reply = replies(tree).at(-1)!;
    expect(reply.message.toolCalls).not.toBeNull();
    expect(reply.tools).toEqual([]);
    const items: ToolItem[] = works(tree).flatMap((work: Work) =>
      work.items.filter(
        (item: Work["items"][number]): item is ToolItem => item.kind === "tool",
      ),
    );
    expect(items.map((item: ToolItem) => item.call.id)).toEqual(
      reply.message.toolCalls!.map((call: ToolCall) => call.id),
    );
    expect(
      items.some((item: ToolItem) => item.result?.status === "stopped"),
    ).toBe(true);
  });

  test("regenerate applies both deletion boundaries", async () => {
    const run = await drive("regenerate.ndjson");
    const starts = run.steps.filter(
      (step) =>
        "type" in step.line &&
        step.line.type === "chat" &&
        step.line.data.kind === "started",
    );
    expect(starts).toHaveLength(2);
    const first = groupRows(starts[0].state, run.toolsOn);
    const second = groupRows(starts[1].state, run.toolsOn);
    expect(
      first.some(
        (node: Node) => node.kind === "user" && node.message.id === 153,
      ),
    ).toBe(true);
    expect(
      second.some(
        (node: Node) => node.kind === "user" && node.message.id === 164,
      ),
    ).toBe(true);
    expect(
      second.some(
        (node: Node) => node.kind === "user" && node.message.id === 153,
      ),
    ).toBe(false);
  });

  test("second turn preserves the completed tools turn", async () => {
    const first = await drive("tools.ndjson");
    const before = treeOf(first);
    const second = await drive("second-turn.ndjson", first.state!);
    const after = treeOf(second);
    expect(after.filter((node) => node.kind === "user")).toHaveLength(2);
    const priorKeys = works(before).map((work) => work.key);
    expect(works(after).map((work) => work.key)).toEqual(
      expect.arrayContaining(priorKeys),
    );
  });

  test("tool errors stay attached to a failed ToolNode", async () => {
    const tree = treeOf(await drive("tool-error.ndjson"));
    expect(
      toolNodes(tree).some((tool) => tool.result?.status === "error"),
    ).toBe(true);
  });

  test("/compact streams into a summary node and the next reply follows it", async () => {
    const run = await drive("compact.ndjson");
    const summaries = (tree: Node[]) =>
      tree.filter((node) => node.kind === "summary");
    // while the summary round runs the node is live and the send is on
    const streaming = run.steps.find(
      (step) =>
        "type" in step.line &&
        step.line.type === "chat" &&
        step.line.data.kind === "delta",
    )!;
    const live = summaries(groupRows(streaming.state, run.toolsOn));
    expect(live).toHaveLength(1);
    expect(live[0].live).not.toBeNull();
    expect(live[0].message.role).toBe("summary");
    expect(streaming.state.running).not.toBeNull();
    const tree = treeOf(run);
    const done = summaries(tree);
    expect(done).toHaveLength(1);
    expect(done[0].live).toBeNull();
    expect(done[0].message.status).toBe("done");
    expect(done[0].message.stats?.promptTokens).toBeGreaterThan(0);
    expect(done[0].message.content).toMatch(/^## Goal/);
    // the follow-up sent after it renders as user, then reply
    const after = tree.slice(tree.indexOf(done[0]) + 1);
    expect(after.map((node) => node.kind)).toEqual(["user", "reply"]);
    // a summary after the last reply leaves it its Regenerate: the
    // recording joined mid-chat, so a second summary is appended by hand
    const state = run.state!;
    const reply = replies(after)[0].message;
    const again = { ...done[0].message, id: reply.id + 1 };
    const nodes = groupRows(
      {
        ...state,
        chat: { ...state.chat, messages: [...state.chat.messages, again] },
      },
      run.toolsOn,
    );
    expect(nodes.at(-1)?.kind).toBe("summary");
    expect(replies(nodes).at(-1)?.last).toBe(true);
  });

  test("a tool limit folds the unrun calls and keeps the answer as the reply", async () => {
    const tree = treeOf(await drive("tool-limit.ndjson"));
    expect(works(tree)).toHaveLength(1);
    const tools = toolNodes(tree);
    expect(tools).toHaveLength(9);
    expect(tools.every((tool) => tool.result?.status === "stopped")).toBe(true);
    const reply = replies(tree).at(-1)!;
    expect(reply.message.finishReason).toBe("stop");
    expect(reply.message.content).not.toBe("");
    expect(reply.tools).toHaveLength(0);
    const limited = works(tree)[0].items.find(
      (item) =>
        item.kind === "round" && item.message.finishReason === "tool_limit",
    );
    expect(limited).toBeDefined();
    expect(works(tree)[0].label).toMatch(
      /^Worked for .* · 9 tool calls, tool limit$/,
    );
  });

  test("a thinking stop leaves reasoning on the reply", async () => {
    const tree = treeOf(await drive("think-stop.ndjson"));
    expect(works(tree)).toHaveLength(0);
    const reply = replies(tree).at(-1)!;
    expect(reply.message.reasoning).not.toBe("");
    expect(reply.message.content).toBe("");
    expect(reply.think).toBe(true);
  });

  test("a stopped cold load has an empty reply and no group", async () => {
    const tree = treeOf(await drive("cold-load.ndjson"));
    expect(works(tree)).toHaveLength(0);
    const reply = replies(tree).at(-1)!;
    expect(reply.message.status).toBe("stopped");
    expect(reply.message.content).toBe("");
    expect(reply.message.reasoning).toBe("");
  });

  test("reconnect converges with the uninterrupted event path", async () => {
    const lines = await loadRecording("reconnect.ndjson");
    const reloaded = driveRecording("reconnect.ndjson", lines);
    const continuous = driveRecording("reconnect.ndjson", lines, {
      honorReload: false,
    });
    expect(treeOf(reloaded)).toEqual(treeOf(continuous));
  });

  test("a fetched interruption is settled and not running", async () => {
    const run = await drive("interrupted.ndjson");
    expect(run.state?.running).toBeNull();
    expect(replies(treeOf(run)).at(-1)?.message.status).toBe("interrupted");
  });
});
