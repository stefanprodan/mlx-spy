// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ChatTool, ToolCall } from "./engine/types.ts";
import type { SearchProvider } from "./tools/search/types.ts";
import { formatCurrentTime, HOST_TIMEZONE } from "./tools/time.ts";
import { webfetchTool } from "./tools/webfetch.ts";
import { websearchTool } from "./tools/websearch.ts";

const TOOL_TIMEOUT_MS = 20_000;
const MAX_RESULT_CHARS = 50_000;

export type SendBudget = {
  toolCalls: number;
  fetches: number;
  searches: number;
  toolMs: number;
  resultBytes: number;
};

export type ToolContext = {
  signal: AbortSignal;
  now(): number;
  engine: URL;
  version: string;
  search: { provider: SearchProvider; key: string | null };
  budget: SendBudget;
};

export type ToolDef = {
  name: string;
  description: string;
  parameters: object;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
};

export { type CurrentTime, formatCurrentTime } from "./tools/time.ts";

function timezone(args: Record<string, unknown>): string {
  if (typeof args.timezone !== "string" || args.timezone === "") {
    throw new Error("timezone must be a non-empty string");
  }
  return args.timezone;
}

export const TOOLS: ToolDef[] = [
  {
    name: "get_current_time",
    description: "Get the current time in a specific timezone.",
    parameters: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description: `IANA timezone name. Use ${HOST_TIMEZONE} when the user did not specify one.`,
        },
      },
      required: ["timezone"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return JSON.stringify(formatCurrentTime(ctx.now(), timezone(args)));
    },
  },
  webfetchTool,
  websearchTool,
];

// A description may carry {{year}}, filled at send time in the host's
// timezone: a model searching for "the latest" tends to write the year its
// weights end in, the date line in the system prompt notwithstanding
// (seen 2026-09-09), so the year sits where the query is composed.
export function toolSchemas(names?: string[], now = Date.now()): ChatTool[] {
  const enabled = names === undefined ? null : new Set(names);
  const year = formatCurrentTime(now, HOST_TIMEZONE).datetime.slice(0, 4);
  return TOOLS.filter((tool) => enabled === null || enabled.has(tool.name)).map(
    ({ name, description, parameters }) => ({
      name,
      description: description.replaceAll("{{year}}", year),
      parameters,
    }),
  );
}

function clean(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const control =
      (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159);
    if (!control) result += text[index];
  }
  return result.slice(0, MAX_RESULT_CHARS);
}

function describe(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "tool timed out after 20 seconds";
  }
  return error instanceof Error ? error.message : String(error);
}

export async function runTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<{ text: string; error: string | null }> {
  try {
    const tool = TOOLS.find((item) => item.name === call.name);
    if (!tool) throw new Error(`tool "${call.name}" not found.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.arguments === "" ? "{}" : call.arguments);
    } catch {
      throw new Error(`invalid JSON arguments for tool "${call.name}"`);
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(`arguments for tool "${call.name}" must be an object`);
    }
    const signal = AbortSignal.any([
      ctx.signal,
      AbortSignal.timeout(TOOL_TIMEOUT_MS),
    ]);
    const text = await tool.run(parsed as Record<string, unknown>, {
      ...ctx,
      signal,
    });
    return { text: clean(String(text)), error: null };
  } catch (error) {
    const message = describe(error);
    return { text: clean(`Error: ${message}`), error: message };
  }
}
