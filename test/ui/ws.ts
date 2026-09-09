// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ChatWsEvent } from "../../src/chat.ts";
import type { Chat, ChatSettings, ChatSummary } from "../../src/chats.ts";
import {
  applyEvent,
  type ChatState,
  type Running,
  stateOf,
} from "../../src/ui/chat/events.ts";

export const recordings = [
  "plain.ndjson",
  "tools.ndjson",
  "stop.ndjson",
  "regenerate.ndjson",
  "reconnect.ndjson",
  "cold-load.ndjson",
  "tools-stop-round.ndjson",
  "tools-stop-call.ndjson",
  "second-turn.ndjson",
  "think-stop.ndjson",
  "tool-error.ndjson",
  "interrupted.ndjson",
] as const;

export type RecordingName = (typeof recordings)[number];
export type NoteLine = { t: number; note: string };
export type SnapshotLine = {
  t: number;
  type: "snapshot";
  chat: Running;
};
export type ChatLine = { t: number; type: "chat"; data: ChatWsEvent };
export type FetchLine = {
  t: number;
  fetch: { status: number; body: Chat };
};
export type ReconnectLine = { t: number; reconnect: true };
export type ClosedLine = { t: number; closed: true };
export type RecordingLine =
  | NoteLine
  | SnapshotLine
  | ChatLine
  | FetchLine
  | ReconnectLine
  | ClosedLine;

export async function loadRecording(
  name: RecordingName,
): Promise<RecordingLine[]> {
  const url = new URL(`../fixtures/ws/${name}`, import.meta.url);
  const text = await Bun.file(url).text();
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RecordingLine);
}

const toolNames = ["get_current_time", "webfetch", "websearch"];

export function recordingToolsOn(
  name: RecordingName,
  lines: RecordingLine[],
): boolean {
  const chat = lines
    .filter(
      (line): line is ChatLine =>
        "type" in line && line.type === "chat" && line.data.kind === "chat",
    )
    .at(-1);
  if (chat?.data.kind === "chat") {
    const off = chat.data.chat.toolsOff ?? [];
    return toolNames.some((tool) => !off.includes(tool));
  }
  return name !== "plain.ndjson" && name !== "regenerate.ndjson";
}

export type DriveStep = {
  line: RecordingLine;
  state: ChatState;
  gap: boolean;
};

export type DrivenRecording = {
  state: ChatState | null;
  steps: DriveStep[];
  gaps: boolean[];
  toolsOn: boolean;
};

export type DriveOptions = {
  initial?: ChatState;
  honorReload?: boolean;
};

const fallbackSettings = (toolsOn: boolean): Omit<ChatSettings, "model"> => ({
  systemPrompt: "",
  thinking: true,
  reasoningEffort: null,
  temperature: null,
  topP: null,
  maxTokens: null,
  toolsOff: toolsOn ? [] : toolNames,
  search: "exa",
});

function initialChat(
  summary: ChatSummary,
  settings: (ChatSummary & ChatSettings) | null,
  toolsOn: boolean,
): Chat {
  return {
    ...fallbackSettings(toolsOn),
    ...settings,
    ...summary,
    messages: [],
  };
}

export function driveRecording(
  name: RecordingName,
  lines: RecordingLine[],
  options: DriveOptions = {},
): DrivenRecording {
  const honorReload = options.honorReload ?? true;
  const toolsOn = recordingToolsOn(name, lines);
  let state = options.initial
    ? stateOf(options.initial.chat, options.initial.running)
    : null;
  let running: Running = state?.running ?? null;
  let settings: (ChatSummary & ChatSettings) | null =
    options.initial?.chat ?? null;
  let pending: ChatLine[] | null = null;
  const steps: DriveStep[] = [];
  const gaps: boolean[] = [];

  const apply = (line: ChatLine) => {
    const event = line.data;
    if (event.kind === "chat") settings = event.chat;
    if (!state && event.kind === "started") {
      state = stateOf(initialChat(event.chat, settings, toolsOn), running);
    }
    if (!state) return;
    const result = applyEvent(state, event, line.t);
    state = result.state;
    running = state.running;
    gaps.push(result.gap);
    steps.push({ line, state, gap: result.gap });
  };

  for (const line of lines) {
    if ("note" in line) continue;
    if ("reconnect" in line || "closed" in line) {
      if (!honorReload) continue;
      state = null;
      running = null;
      pending = null;
      continue;
    }
    if ("type" in line && line.type === "snapshot") {
      if (!honorReload) continue;
      running = line.chat;
      if (state) state = { ...state, running };
      pending = line.chat ? [] : null;
      continue;
    }
    if ("fetch" in line) {
      if (!honorReload) continue;
      state = stateOf(line.fetch.body, running);
      steps.push({ line, state, gap: false });
      const queued = pending ?? [];
      pending = null;
      for (const event of queued) apply(event);
      continue;
    }
    if ("type" in line && line.type === "chat") {
      if (pending) pending.push(line);
      else apply(line);
    }
  }

  return { state, steps, gaps, toolsOn };
}
