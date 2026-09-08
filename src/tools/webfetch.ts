// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ToolContext, ToolDef } from "../tools.ts";

const DEADLINE_MS = 15_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_FETCHES = 6;
const BODY_CUT_NOTE = "<error>Content truncated at 2 MB.</error>";

export type Resolver = (host: string) => Promise<string[]>;
export type PinnedFetch = (
  input: string,
  init: RequestInit & { tls?: { serverName: string } },
) => Promise<Response>;

export type FetchDependencies = {
  resolve: Resolver;
  fetch: PinnedFetch;
};

type ParsedAddress =
  | { family: 4; parts: number[] }
  | { family: 6; parts: number[] };

type MediaType = {
  type: string;
  charset: string;
};

class TextWriter {
  private value = "";
  private pendingSpace = false;

  text(text: string): void {
    for (const character of text) {
      if (/\s/u.test(character)) {
        this.pendingSpace = true;
      } else {
        if (
          this.pendingSpace &&
          this.value !== "" &&
          !this.value.endsWith("\n") &&
          !this.value.endsWith(" ")
        ) {
          this.value += " ";
        }
        this.pendingSpace = false;
        this.value += character;
      }
    }
  }

  raw(text: string): void {
    this.pendingSpace = false;
    this.value += text;
  }

  line(): void {
    this.pendingSpace = false;
    this.value = this.value.replace(/[ \t]+$/u, "");
    if (!this.value.endsWith("\n\n")) this.value += "\n";
  }

  singleLine(): void {
    this.pendingSpace = false;
    this.value = this.value.replace(/[ \t]+$/u, "");
    if (!this.value.endsWith("\n")) this.value += "\n";
  }

  result(): string {
    return this.value.trim();
  }
}

function parseIpv4(input: string): number[] | null {
  const fields = input.split(".");
  if (fields.length !== 4) return null;
  const parts: number[] = [];
  for (const field of fields) {
    if (!/^\d{1,3}$/u.test(field)) return null;
    const value = Number(field);
    if (value > 255) return null;
    parts.push(value);
  }
  return parts;
}

function parseIpv6(input: string): number[] | null {
  let address = input.toLowerCase();
  if (address.startsWith("[") && address.endsWith("]")) {
    address = address.slice(1, -1);
  }
  if (address.includes("%") || address === "") return null;

  const dotted = address.lastIndexOf(":");
  if (address.includes(".") && dotted >= 0) {
    const ipv4 = parseIpv4(address.slice(dotted + 1));
    if (!ipv4) return null;
    const high = (ipv4[0] << 8) | ipv4[1];
    const low = (ipv4[2] << 8) | ipv4[3];
    address = `${address.slice(0, dotted)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0].split(":");
  const right =
    halves.length === 1 || halves[1] === "" ? [] : halves[1].split(":");
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const fields = [...left, ...Array(missing).fill("0"), ...right];
  if (
    fields.length !== 8 ||
    fields.some((field) => !/^[0-9a-f]{1,4}$/u.test(field))
  ) {
    return null;
  }
  return fields.map((field) => Number.parseInt(field, 16));
}

function parseAddress(input: string): ParsedAddress | null {
  const ipv4 = parseIpv4(input);
  if (ipv4) return { family: 4, parts: ipv4 };
  const ipv6 = parseIpv6(input);
  return ipv6 ? { family: 6, parts: ipv6 } : null;
}

function classifyIpv4(parts: number[]): string {
  const [a, b, c, d] = parts;
  if (a === 0 && b === 0 && c === 0 && d === 0) return "unspecified";
  if (a === 0) return "reserved";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  ) {
    return "private";
  }
  if (a === 100 && b >= 64 && b <= 127) return "CGNAT";
  if (a >= 224 && a <= 239) return "multicast";
  if (a === 255 && b === 255 && c === 255 && d === 255) return "broadcast";
  if (a >= 240) return "reserved";
  if (
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return "documentation";
  }
  if (a === 198 && (b === 18 || b === 19)) return "benchmark";
  return "global";
}

// the classes a tool may connect to: the public internet and the user's
// own networks (LAN, tailnet CGNAT, ULA). Loopback is this host, where
// mlx-spy and the engine listen; the rest is not a place a page lives.
const REACHABLE = new Set(["global", "private", "CGNAT"]);

export function classifyAddress(input: string): string {
  const address = parseAddress(input);
  if (!address) return "invalid address";
  if (address.family === 4) return classifyIpv4(address.parts);

  const parts = address.parts;
  const mapped =
    parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
  const nat64 =
    parts[0] === 0x64 &&
    parts[1] === 0xff9b &&
    parts.slice(2, 6).every((part) => part === 0);
  if (mapped || nat64) {
    return classifyIpv4([
      parts[6] >> 8,
      parts[6] & 0xff,
      parts[7] >> 8,
      parts[7] & 0xff,
    ]);
  }
  if (parts.every((part) => part === 0)) return "unspecified";
  if (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) {
    return "loopback";
  }
  if ((parts[0] & 0xffc0) === 0xfe80) return "link-local";
  if ((parts[0] & 0xfe00) === 0xfc00) return "private";
  if ((parts[0] & 0xff00) === 0xff00) return "multicast";
  if (parts[0] === 0x2001 && parts[1] === 0x0db8) {
    return "documentation";
  }
  return "global";
}

function normalizedHost(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

function isAddress(host: string): boolean {
  return parseAddress(host) !== null;
}

// only names for this host are refused: the tailnet, the LAN, mDNS and
// bare names resolve to machines the user runs, and reading them is the
// point of a local tool. The engine is reachable too, by decision
// (2026-09-08): the user owns it and wants the model to read it.
function refusedHostReason(host: string): string | null {
  if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
  return null;
}

export function parseFetchUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`invalid URL "${input}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`scheme "${url.protocol}" is not allowed`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("credentials in URLs are not allowed");
  }
  const host = normalizedHost(url.hostname);
  if (host === "") throw new Error("URL has no host");
  url.hostname = host.includes(":") ? `[${host}]` : host;
  return url;
}

function hostHeader(host: string, port: string): string {
  const authority = host.includes(":") ? `[${host}]` : host;
  return port === "" ? authority : `${authority}:${port}`;
}

async function checkedAddress(
  url: URL,
  resolve: Resolver,
  signal: AbortSignal,
): Promise<{ addresses: string[]; host: string }> {
  const host = normalizedHost(url.hostname);

  let addresses: string[];
  if (isAddress(host)) {
    addresses = [host];
  } else {
    const refused = refusedHostReason(host);
    if (refused) throw new Error(`host "${host}" is refused: ${refused}`);
    addresses = await resolve(host);
    signal.throwIfAborted();
    if (addresses.length === 0) {
      throw new Error(`host "${host}" did not resolve`);
    }
  }

  for (const address of addresses) {
    const classification = classifyAddress(address);
    if (!REACHABLE.has(classification)) {
      throw new Error(`address ${address} is ${classification}`);
    }
  }
  // IPv4 first: a host with no IPv6 route fails on the AAAA answers that
  // resolvers list first, and the next address is tried on a socket error
  const v4 = addresses.filter((address) => !address.includes(":"));
  const v6 = addresses.filter((address) => address.includes(":"));
  return { addresses: [...v4, ...v6], host };
}

// a connection that never opened (no route, refused, reset); anything the
// server answered is not retried on another address
function isConnectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code ?? "";
  return (
    /FailedToOpenSocket|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ConnectionRefused|ConnectionClosed/.test(
      code,
    ) || /typo in the url or port|Unable to connect/i.test(error.message)
  );
}

function mediaType(header: string | null): MediaType {
  if (header === null || header.trim() === "") {
    throw new Error("media type is missing");
  }
  const type = header.split(";", 1)[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(type)) {
    throw new Error(`media type "${type}" is not allowed`);
  }
  const allowed =
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml");
  if (!allowed) throw new Error(`media type "${type}" is not allowed`);
  const match = header.match(
    /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/iu,
  );
  return {
    type,
    charset: match?.[1] || match?.[2] || match?.[3] || "utf-8",
  };
}

async function readBody(
  response: Response,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; cut: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), cut: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  while (true) {
    signal.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    if (size === MAX_BODY_BYTES) {
      cut = true;
      await reader.cancel();
      break;
    }
    const remaining = MAX_BODY_BYTES - size;
    const chunk =
      value.byteLength > remaining ? value.subarray(0, remaining) : value;
    chunks.push(chunk);
    size += chunk.byteLength;
    if (value.byteLength > remaining) {
      cut = true;
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, cut };
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export async function extractHtml(html: string, baseUrl: URL): Promise<string> {
  const body = new TextWriter();
  const title = new TextWriter();
  let skipDepth = 0;
  let preDepth = 0;
  let titleDepth = 0;
  const rewriter = new HTMLRewriter();

  rewriter.on(
    "script, style, noscript, iframe, svg, template, nav, footer, header",
    {
      element(element) {
        skipDepth++;
        element.onEndTag(() => {
          skipDepth--;
        });
        element.remove();
      },
    },
  );
  rewriter.on("title", {
    element(element) {
      titleDepth++;
      element.onEndTag(() => {
        titleDepth--;
      });
    },
  });
  rewriter.on(
    "p, div, section, article, main, tr, blockquote, table, ul, ol, dl, dt, dd",
    {
      element(element) {
        if (skipDepth > 0) return;
        body.line();
        element.onEndTag(() => body.line());
      },
    },
  );
  rewriter.on("br, hr", {
    element() {
      if (skipDepth === 0) body.line();
    },
  });
  for (let level = 1; level <= 6; level++) {
    rewriter.on(`h${level}`, {
      element(element) {
        if (skipDepth > 0) return;
        body.line();
        body.text(`${"#".repeat(level)} `);
        element.onEndTag(() => body.line());
      },
    });
  }
  rewriter.on("li", {
    element(element) {
      if (skipDepth > 0) return;
      body.singleLine();
      body.text("- ");
      element.onEndTag(() => body.singleLine());
    },
  });
  rewriter.on("pre", {
    element(element) {
      if (skipDepth > 0) return;
      body.line();
      preDepth++;
      element.onEndTag(() => {
        preDepth--;
        body.line();
      });
    },
  });
  rewriter.on("a", {
    element(element) {
      if (skipDepth > 0) return;
      const href = element.getAttribute("href");
      if (!href) return;
      let absolute: URL;
      try {
        absolute = new URL(href, baseUrl);
      } catch {
        return;
      }
      if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
        return;
      }
      element.onEndTag(() => body.text(` (${absolute.href})`));
    },
  });
  rewriter.on("*", {
    text(text) {
      if (skipDepth > 0) return;
      if (titleDepth > 0) {
        title.text(text.text);
      } else if (preDepth > 0) {
        body.raw(text.text);
      } else {
        body.text(text.text);
      }
    },
  });

  await rewriter.transform(new Response(html)).text();
  const pageTitle = title.result();
  const pageBody = body.result();
  if (pageTitle && pageBody) return `${pageTitle}\n\n${pageBody}`;
  return pageTitle || pageBody;
}

export function sliceContent(
  text: string,
  startIndex: number,
  maxLength: number,
): string {
  if (startIndex >= text.length) {
    return "<error>No more content available.</error>";
  }
  const end = startIndex + maxLength;
  const result = text.slice(startIndex, end);
  if (end < text.length) {
    return `${result}\n\n<error>Content truncated. Call the webfetch tool with a start_index of ${end} to get more content.</error>`;
  }
  return result;
}

function integerArgument(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum?: number,
): number {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== "number" ||
    !Number.isInteger(result) ||
    result < minimum ||
    (maximum !== undefined && result > maximum)
  ) {
    const range =
      maximum === undefined ? `at least ${minimum}` : `${minimum}..${maximum}`;
    throw new Error(`${name} must be an integer in ${range}`);
  }
  return result;
}

export async function fetchText(
  args: Record<string, unknown>,
  ctx: ToolContext,
  dependencies: FetchDependencies = {
    resolve: async (host) =>
      (await Bun.dns.lookup(host, {})).map((entry) => entry.address),
    fetch: (input, init) => fetch(input, init),
  },
): Promise<string> {
  if (typeof args.url !== "string" || args.url === "") {
    throw new Error("url must be a non-empty string");
  }
  const maxLength = integerArgument(
    args.max_length,
    "max_length",
    5000,
    1,
    50_000,
  );
  const startIndex = integerArgument(args.start_index, "start_index", 0, 0);
  if (ctx.budget.fetches >= MAX_FETCHES) throw new Error("fetch limit reached");
  ctx.budget.fetches++;

  const deadline = AbortSignal.any([
    ctx.signal,
    AbortSignal.timeout(DEADLINE_MS),
  ]);
  try {
    const firstUrl = parseFetchUrl(args.url);
    let url = firstUrl;
    let redirects = 0;

    while (true) {
      let checked: { addresses: string[]; host: string };
      try {
        checked = await checkedAddress(url, dependencies.resolve, deadline);
      } catch (error) {
        if (redirects > 0) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`redirect refused: ${reason}`);
        }
        throw error;
      }
      deadline.throwIfAborted();
      const init: RequestInit & { tls?: { serverName: string } } = {
        method: "GET",
        headers: {
          Host: hostHeader(checked.host, url.port),
          "User-Agent": `mlx-spy/${ctx.version}`,
          Accept:
            "text/html, text/plain, application/json, application/xml, text/*;q=0.9",
        },
        redirect: "manual",
        signal: deadline,
      };
      if (url.protocol === "https:") {
        init.tls = { serverName: checked.host };
      }
      let response: Response | null = null;
      let connectError: unknown = null;
      for (const address of checked.addresses) {
        const pinned = new URL(url.href);
        pinned.hostname = address.includes(":") ? `[${address}]` : address;
        try {
          response = await dependencies.fetch(pinned.href, init);
          break;
        } catch (error) {
          deadline.throwIfAborted();
          if (!isConnectError(error)) throw error;
          connectError = error;
        }
      }
      if (response === null) {
        const n = checked.addresses.length;
        throw new Error(
          `could not connect to ${checked.host} (${n} address${n === 1 ? "" : "es"} tried)`,
          { cause: connectError },
        );
      }
      const location = response.headers.get("location");
      if (
        [301, 302, 303, 307, 308].includes(response.status) &&
        location !== null
      ) {
        await response.body?.cancel();
        if (redirects >= 3) {
          throw new Error("redirect limit exceeded after 3 hops");
        }
        try {
          url = parseFetchUrl(new URL(location, url).href);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`redirect refused: ${reason}`);
        }
        redirects++;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        throw new Error(`HTTP status ${response.status}`);
      }

      const type = mediaType(response.headers.get("content-type"));
      const body = await readBody(response, deadline);
      let text = decode(body.bytes, type.charset);
      if (type.type === "text/html" || type.type === "application/xhtml+xml") {
        text = await extractHtml(text, url);
      }
      if (body.cut) text = `${text}\n\n${BODY_CUT_NOTE}`;
      return sliceContent(text, startIndex, maxLength);
    }
  } catch (error) {
    if (
      deadline.aborted &&
      deadline.reason instanceof DOMException &&
      deadline.reason.name === "TimeoutError"
    ) {
      throw new Error("fetch timed out after 15 seconds");
    }
    throw error;
  }
}

export const webfetchTool: ToolDef = {
  name: "webfetch",
  description:
    "Fetch a URL and return its text. Long pages are returned in slices; call webfetch again with start_index set to the next index named in the truncation message.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to fetch.",
      },
      max_length: {
        type: "integer",
        minimum: 1,
        maximum: 50_000,
        default: 5000,
        description: "Maximum number of characters to return.",
      },
      start_index: {
        type: "integer",
        minimum: 0,
        default: 0,
        description: "Character index at which to start the returned slice.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  run: fetchText,
};
