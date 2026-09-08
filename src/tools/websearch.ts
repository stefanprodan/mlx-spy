// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ToolContext, ToolDef } from "../tools.ts";
import * as exa from "./search/exa.ts";
import * as firecrawl from "./search/firecrawl.ts";
import {
  ProviderError,
  type ProviderRequest,
  type SearchArgs,
  type SearchKeys,
} from "./search/types.ts";

const MAX_SEARCHES = 3;
const MAX_BODY_BYTES = 1024 * 1024;
const DEADLINE_MS = 10_000;

export type SearchDependencies = {
  fetch: typeof fetch;
  deadlineMs: number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
};

const defaults: SearchDependencies = {
  fetch,
  deadlineMs: DEADLINE_MS,
  sleep: (ms, signal) =>
    new Promise<void>((resolveSleep, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(resolveSleep, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    }),
};

function domainError(): never {
  throw new Error(
    "domain must be a host name with at least two labels and at most 253 characters",
  );
}

export function parseArgs(args: Record<string, unknown>): SearchArgs {
  if (typeof args.query !== "string" || args.query.trim() === "") {
    throw new Error("query must be a non-empty string");
  }
  const query = args.query.trim();
  if (query.length > 500)
    throw new Error("query must be at most 500 characters");
  if (args.domain === undefined || args.domain === null) {
    return { query, domain: null };
  }
  if (typeof args.domain !== "string") return domainError();
  // a trailing dot is the DNS root; neither provider wants it
  const domain = args.domain.trim().toLowerCase().replace(/\.$/u, "");
  if (
    domain === "" ||
    domain.length > 253 ||
    !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/u.test(domain)
  ) {
    return domainError();
  }
  return { query, domain };
}

export function retryAfterMs(header: string | null): number | null {
  if (header === null) return 1000;
  const value = header.trim();
  if (value === "" || /^-\d+$/u.test(value)) return 1000;
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    return seconds <= 10 ? seconds * 1000 : null;
  }
  if (Number.isFinite(Number(value)) || Number.isFinite(Date.parse(value))) {
    return null;
  }
  return 1000;
}

export function secretsDirFor(main: string, execPath: string): string {
  return main.endsWith(".ts")
    ? resolve(dirname(main), "../.preview/secrets")
    : resolve(dirname(execPath), "../secrets");
}

export function secretsDir(): string {
  return secretsDirFor(Bun.main, process.execPath);
}

function keyError(path: string, message: string): never {
  throw new Error(`search key ${path}: ${message}`);
}

export function loadKey(path: string): string | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    return keyError(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!stat.isFile()) return keyError(path, "not a regular file");
  if (stat.size > 4096) return keyError(path, "must be at most 4 KB");
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch (error) {
    return keyError(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (value === "") return keyError(path, "must not be empty");
  if (!/^[\x20-\x7e]+$/u.test(value)) {
    return keyError(path, "must contain printable ASCII only");
  }
  return value;
}

export function loadSearchKeys(dir: string): SearchKeys {
  return {
    exa: loadKey(join(dir, "exa.key")),
    firecrawl: loadKey(join(dir, "firecrawl.key")),
  };
}

function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolveRace, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolveRace(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

// discarding a body is best effort: the cancel is not awaited, so a stream
// whose cancel hangs or rejects cannot hold the deadline or replace the error
function discard(body: ReadableStream<Uint8Array> | null): void {
  body?.cancel().catch(() => {});
}

async function readBody(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await raceSignal(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        reader.cancel().catch(() => {});
        throw new Error("websearch answer over 1 MB");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal.aborted) reader.cancel(signal.reason).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function serverText(text: string): string {
  let clean = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13) clean += " ";
    else if (code >= 32 && !(code >= 127 && code <= 159)) {
      clean += text[index];
    }
  }
  return clean.replace(/\s+/gu, " ").trim().slice(0, 300);
}

function errorFromBody(body: string): string | null {
  try {
    const value = JSON.parse(body);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const error = (value as Record<string, unknown>).error;
    return typeof error === "string" ? serverText(error) : null;
  } catch {
    return null;
  }
}

function providerError(error: ProviderError): Error {
  const text = serverText(error.message);
  return new Error(
    error.keyRejected ? `websearch key rejected: ${text}` : text,
  );
}

async function post(
  request: ProviderRequest,
  keySent: boolean,
  parse: (body: string, contentType: string | null, key: boolean) => string,
  signal: AbortSignal,
  deadlineAt: number,
  dependencies: SearchDependencies,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const response = await raceSignal(
      Promise.resolve().then(() =>
        dependencies.fetch(request.url, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          redirect: "error",
          signal,
        }),
      ),
      signal,
    );
    if (response.status === 429) {
      const delay = retryAfterMs(response.headers.get("retry-after"));
      discard(response.body);
      if (attempt === 1 || delay === null || delay >= deadlineAt - Date.now()) {
        throw new Error("websearch rate limited, try again in a moment");
      }
      await raceSignal(dependencies.sleep(delay, signal), signal);
      continue;
    }
    const body = await readBody(response, signal);
    if (response.status < 200 || response.status >= 300) {
      const text = errorFromBody(body);
      if (keySent && response.status === 401 && text !== null) {
        throw new Error(`websearch key rejected: ${text}`);
      }
      if (!keySent && response.status === 403 && text !== null) {
        throw new Error(`websearch refused: ${text}`);
      }
      throw new Error(
        text === null
          ? `websearch failed (HTTP ${response.status})`
          : `websearch failed (HTTP ${response.status}): ${text}`,
      );
    }
    try {
      return parse(body, response.headers.get("content-type"), keySent);
    } catch (error) {
      if (error instanceof ProviderError) throw providerError(error);
      throw error;
    }
  }
  throw new Error("websearch rate limited, try again in a moment");
}

export async function searchWeb(
  args: Record<string, unknown>,
  ctx: ToolContext,
  dependencies: SearchDependencies = defaults,
): Promise<string> {
  const parsed = parseArgs(args);
  if (ctx.budget.searches >= MAX_SEARCHES) {
    throw new Error("search limit reached");
  }
  ctx.budget.searches++;
  const provider = ctx.search.provider;
  const key = ctx.search.key;
  const request =
    provider === "exa"
      ? exa.buildRequest(parsed, key, ctx.version)
      : firecrawl.buildRequest(parsed, key, ctx.version);
  const parse = provider === "exa" ? exa.parseAnswer : firecrawl.parseAnswer;
  const timeout = AbortSignal.timeout(dependencies.deadlineMs);
  const signal = AbortSignal.any([ctx.signal, timeout]);
  const deadlineAt = Date.now() + dependencies.deadlineMs;
  try {
    return await post(
      request,
      key !== null,
      parse,
      signal,
      deadlineAt,
      dependencies,
    );
  } catch (error) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    if (timeout.aborted) throw new Error("search timed out after 10 seconds");
    throw error;
  }
}

export const websearchTool: ToolDef = {
  name: "websearch",
  description:
    "Search the web. Describe the page you want in a sentence rather than keywords; set domain to limit the results to one site. Returns titles, URLs and excerpts; call webfetch on a result's URL to read the whole page.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "Describe the page you want in a sentence.",
      },
      domain: {
        type: "string",
        description: "Limit results to this site, e.g. fluxcd.io. Optional.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  run: searchWeb,
};
