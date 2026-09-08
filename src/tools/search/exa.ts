// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  ProviderError,
  type ProviderRequest,
  type SearchArgs,
} from "./types.ts";

function unexpected(): never {
  throw new Error("websearch answered with an unexpected shape");
}

function messageData(body: string): string {
  const lines = body.replace(/\r\n?/gu, "\n").split("\n");
  let event = "message";
  let data: string[] = [];
  const dispatch = () => {
    if (event === "message" && data.length > 0) return data.join("\n");
    event = "message";
    data = [];
    return null;
  };
  for (const line of lines) {
    if (line === "") {
      const value = dispatch();
      if (value !== null) return value;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return dispatch() ?? unexpected();
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return unexpected();
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("websearch ")) {
      throw error;
    }
    return unexpected();
  }
}

function serverMessage(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return unexpected();
  return value.replace(/^MCP error -?\d+:\s*/u, "");
}

export function buildRequest(
  args: SearchArgs,
  key: string | null,
  version: string,
): ProviderRequest {
  const query = args.domain ? `${args.query} site:${args.domain}` : args.query;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": `mlx-spy/${version}`,
  };
  if (key !== null) headers["x-api-key"] = key;
  return {
    url: "https://mcp.exa.ai/mcp",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: { query, numResults: 5 },
      },
    }),
  };
}

export function parseAnswer(
  body: string,
  contentType: string | null,
  keySent: boolean,
): string {
  const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase();
  const envelope = parseJson(
    mediaType === "application/json" ? body : messageData(body),
  );
  if (envelope.error !== undefined) {
    const error = envelope.error;
    if (typeof error !== "object" || error === null || Array.isArray(error)) {
      return unexpected();
    }
    throw new ProviderError(
      serverMessage((error as Record<string, unknown>).message),
    );
  }
  const result = envelope.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return unexpected();
  }
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.content)) return unexpected();
  const texts: string[] = [];
  for (const item of record.content) {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      (item as Record<string, unknown>).type !== "text" ||
      typeof (item as Record<string, unknown>).text !== "string"
    ) {
      return unexpected();
    }
    texts.push((item as Record<string, unknown>).text as string);
  }
  const text = texts.join("\n\n");
  if (record.isError === true) {
    const message = serverMessage(text);
    throw new ProviderError(
      message,
      keySent && message.startsWith("web_search_exa error (401)"),
    );
  }
  return text.trim() === "" ? "No results." : text;
}
