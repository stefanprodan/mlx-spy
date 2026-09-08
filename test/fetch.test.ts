import { afterEach, describe, expect, test } from "bun:test";
import {
  classifyAddress,
  extractHtml,
  type FetchDependencies,
  fetchText,
  parseFetchUrl,
  sliceContent,
} from "../src/tools/fetch.ts";
import { runTool, type SendBudget, type ToolContext } from "../src/tools.ts";

const PUBLIC_IP = "93.184.216.34";
const ENGINE_IP = "8.8.8.8";
const servers: ReturnType<typeof Bun.serve>[] = [];

function context(engine = "http://engine.example"): ToolContext {
  const budget: SendBudget = {
    toolCalls: 0,
    fetches: 0,
    toolMs: 0,
    resultBytes: 0,
  };
  return {
    signal: new AbortController().signal,
    now: () => 0,
    engine: new URL(engine),
    version: "vtest",
    budget,
  };
}

function dependencies(
  response: (input: string, init: RequestInit) => Response | Promise<Response>,
  addresses: Record<string, string[]> = {},
): FetchDependencies {
  return {
    resolve: async (host) => {
      if (host === "engine.example") return [ENGINE_IP];
      return addresses[host] ?? [PUBLIC_IP];
    },
    fetch: async (input, init) => response(input, init),
  };
}

function textResponse(
  text: BodyInit = "ok",
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/plain; charset=utf-8");
  }
  return new Response(text, { ...init, headers });
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("classifyAddress", () => {
  test("classifies every refused IPv4 range", () => {
    const cases: Array<[string, string]> = [
      ["0.0.0.0", "unspecified"],
      ["0.1.2.3", "reserved"],
      ["127.0.0.1", "loopback"],
      ["169.254.1.2", "link-local"],
      ["10.0.0.1", "private"],
      ["172.16.0.1", "private"],
      ["172.31.255.255", "private"],
      ["192.168.1.1", "private"],
      ["100.64.0.1", "CGNAT"],
      ["100.127.255.254", "CGNAT"],
      ["224.0.0.1", "multicast"],
      ["239.255.255.255", "multicast"],
      ["255.255.255.255", "broadcast"],
      ["240.0.0.1", "reserved"],
      ["192.0.2.1", "documentation"],
      ["198.51.100.1", "documentation"],
      ["203.0.113.1", "documentation"],
      ["198.18.0.1", "benchmark"],
      ["198.19.255.254", "benchmark"],
    ];
    for (const [address, reason] of cases) {
      expect(classifyAddress(address), address).toBe(reason);
    }
    expect(classifyAddress("8.8.8.8")).toBe("global");
    expect(classifyAddress("999.1.1.1")).toBe("invalid address");
  });

  test("classifies every refused IPv6 range", () => {
    const cases: Array<[string, string]> = [
      ["::", "unspecified"],
      ["::1", "loopback"],
      ["fe80::1", "link-local"],
      ["febf:ffff::1", "link-local"],
      ["fc00::1", "private"],
      ["fdff::1", "private"],
      ["ff02::1", "multicast"],
      ["2001:db8::1", "documentation"],
    ];
    for (const [address, reason] of cases) {
      expect(classifyAddress(address), address).toBe(reason);
    }
    expect(classifyAddress("2606:4700:4700::1111")).toBe("global");
    expect(classifyAddress("2001:::1")).toBe("invalid address");
  });

  test("classifies mapped IPv4 and NAT64 by the embedded address", () => {
    expect(classifyAddress("::ffff:10.0.0.1")).toBe("private");
    expect(classifyAddress("::ffff:0a00:0001")).toBe("private");
    expect(classifyAddress("::ffff:8.8.8.8")).toBe("global");
    expect(classifyAddress("64:ff9b::a00:1")).toBe("private");
    expect(classifyAddress("64:ff9b::808:808")).toBe("global");
  });
});

describe("fetch URL guard", () => {
  test("normalizes upper-case hosts, trailing dots and unusual IPv4", () => {
    expect(parseFetchUrl("HTTPS://EXAMPLE.COM./path").href).toBe(
      "https://example.com/path",
    );
    expect(parseFetchUrl("http://2130706433/").hostname).toBe("127.0.0.1");
  });

  test("refuses unsupported schemes and URL credentials", () => {
    for (const url of [
      "file:///tmp/a",
      "data:text/plain,a",
      "blob:https://example.com/id",
      "s3://bucket/key",
    ]) {
      expect(() => parseFetchUrl(url), url).toThrow("is not allowed");
    }
    expect(() => parseFetchUrl("https://user:secret@example.com")).toThrow(
      "credentials in URLs are not allowed",
    );
  });

  test("refuses localhost names before fetching", async () => {
    const called: string[] = [];
    const deps = dependencies((input) => {
      called.push(input);
      return textResponse();
    });
    for (const host of ["localhost", "host.localhost"]) {
      await expect(
        fetchText({ url: `http://${host}/` }, context(), deps),
      ).rejects.toThrow(`host "${host}" is refused`);
    }
    expect(called).toEqual([]);
  });

  // the user's own networks are fair game: the tailnet, the LAN, mDNS and
  // bare names all resolve to hosts the user runs
  test("allows tailnet, LAN and local names", async () => {
    const called: string[] = [];
    const deps = dependencies(
      (input) => {
        called.push(input);
        return textResponse();
      },
      {
        "studio.ts.net": ["100.64.0.7"],
        "nas.local": ["192.168.1.20"],
        printer: ["10.0.0.9"],
        "vault.internal": ["fd12::1"],
      },
    );
    for (const host of [
      "studio.ts.net",
      "nas.local",
      "printer",
      "vault.internal",
      "100.64.0.7",
    ]) {
      await fetchText({ url: `http://${host}/` }, context(), deps);
    }
    expect(called.length).toBe(5);
  });

  test("requires every resolved address to be reachable", async () => {
    const deps = dependencies(() => textResponse(), {
      "mixed.example": [PUBLIC_IP, "127.0.0.2"],
    });
    await expect(
      fetchText({ url: "http://mixed.example/" }, context(), deps),
    ).rejects.toThrow("address 127.0.0.2 is loopback");
  });

  test("pins the checked address and sets host, TLS and request headers", async () => {
    let input = "";
    let options: (RequestInit & { tls?: { serverName: string } }) | undefined;
    const deps = dependencies((url, init) => {
      input = url;
      options = init;
      return textResponse("page");
    });
    const result = await fetchText(
      { url: "https://PUBLIC.EXAMPLE.:8443/path?q=1" },
      context(),
      deps,
    );
    expect(result).toBe("page");
    expect(input).toBe(`https://${PUBLIC_IP}:8443/path?q=1`);
    expect(new Headers(options?.headers).get("host")).toBe(
      "public.example:8443",
    );
    expect(new Headers(options?.headers).get("user-agent")).toBe(
      "mlx-spy/vtest",
    );
    expect(options?.redirect).toBe("manual");
    expect(options?.tls).toEqual({ serverName: "public.example" });
  });

  test("refuses a redirect into a loopback address", async () => {
    let calls = 0;
    const deps = dependencies(() => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/props" },
      });
    });
    await expect(
      fetchText({ url: "https://public.example/start" }, context(), deps),
    ).rejects.toThrow("redirect refused: address 127.0.0.1 is loopback");
    expect(calls).toBe(1);
  });

  test("stops after three redirect hops", async () => {
    let calls = 0;
    const deps = dependencies(() => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: `/hop-${calls}` },
      });
    });
    await expect(
      fetchText({ url: "https://public.example/start" }, context(), deps),
    ).rejects.toThrow("redirect limit exceeded after 3 hops");
    expect(calls).toBe(4);
  });
});

describe("fetch response", () => {
  test("cuts the decoded body at 2 MB and notes the cut", async () => {
    const limit = 2 * 1024 * 1024;
    const bytes = new Uint8Array(limit + 1).fill("a".charCodeAt(0));
    const deps = dependencies(
      () =>
        new Response(bytes, {
          headers: { "content-type": "text/plain" },
        }),
    );
    const result = await fetchText(
      {
        url: "https://public.example/large",
        start_index: limit - 50,
        max_length: 500,
      },
      context(),
      deps,
    );
    expect(result).toBe(
      `${"a".repeat(50)}\n\n<error>Content truncated at 2 MB.</error>`,
    );
  });

  test("refuses missing and unsupported media types", async () => {
    const missing = dependencies(() => new Response("body"));
    await expect(
      fetchText({ url: "https://public.example/" }, context(), missing),
    ).rejects.toThrow("media type is missing");

    const pdf = dependencies(
      () =>
        new Response("pdf", {
          headers: { "content-type": "application/pdf" },
        }),
    );
    await expect(
      fetchText({ url: "https://public.example/file.pdf" }, context(), pdf),
    ).rejects.toThrow('media type "application/pdf" is not allowed');

    const malformed = dependencies(
      () =>
        new Response("body", {
          headers: { "content-type": "text/" },
        }),
    );
    await expect(
      fetchText({ url: "https://public.example/bad" }, context(), malformed),
    ).rejects.toThrow('media type "text/" is not allowed');
  });

  test("decodes the declared charset and falls back on an unknown label", async () => {
    const latin1 = dependencies(
      () =>
        new Response(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), {
          headers: { "content-type": "text/plain; charset=iso-8859-1" },
        }),
    );
    expect(
      await fetchText({ url: "https://public.example/" }, context(), latin1),
    ).toBe("café");

    const unknown = dependencies(
      () =>
        new Response("snowman: ☃", {
          headers: { "content-type": "application/json; charset=no-such" },
        }),
    );
    expect(
      await fetchText({ url: "https://public.example/" }, context(), unknown),
    ).toBe("snowman: ☃");
  });

  test("names a non-success HTTP status", async () => {
    const deps = dependencies(() => textResponse("missing", { status: 404 }));
    await expect(
      fetchText({ url: "https://public.example/missing" }, context(), deps),
    ).rejects.toThrow("HTTP status 404");
  });
});

describe("fetch extraction and slicing", () => {
  test("extracts the saved HTML fixture with skipped and structured elements", async () => {
    const fixture = await Bun.file(
      new URL("fixtures/page.html", import.meta.url),
    ).text();
    const text = await extractHtml(
      fixture,
      new URL("https://example.com/base"),
    );
    expect(text.split("\n", 1)[0]).toBe("Fixture title");
    expect(text).toContain("# First heading");
    expect(text).toContain("## Second");
    expect(text).toContain("###### Sixth");
    expect(text).toContain(
      "A paragraph with collapsed whitespace and the next page (https://example.com/next).",
    );
    expect(text).toContain("- One\n- Two");
    expect(text).toContain("LeftRight");
    expect(text).toContain("Before\nAfter\nRule");
    expect(text).toContain("  exact\n    pre   spacing\n\n\nkept");
    expect(text).toContain("mail link");
    for (const hidden of [
      "SCRIPT MUST NOT APPEAR",
      "NESTED SCRIPT MUST NOT APPEAR",
      "HEADER MUST NOT APPEAR",
      "NAV MUST NOT APPEAR",
      "NOSCRIPT MUST NOT APPEAR",
      "IFRAME MUST NOT APPEAR",
      "SVG MUST NOT APPEAR",
      "TEMPLATE MUST NOT APPEAR",
      "FOOTER MUST NOT APPEAR",
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  test("slices in UTF-16 code units and appends the exact continuation hint", () => {
    expect(sliceContent("a😀bcdef", 1, 3)).toBe(
      "😀b\n\n<error>Content truncated. Call the fetch tool with a start_index of 4 to get more content.</error>",
    );
    expect(sliceContent("abcd", 0, 4)).toBe("abcd");
    expect(sliceContent("abcd", 4, 4)).toBe(
      "<error>No more content available.</error>",
    );
  });
});

describe("fetch loopback canary", () => {
  test("refuses loopback URLs without a connection", async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return new Response("canary");
      },
    });
    servers.push(server);
    const engine = `http://127.0.0.1:${server.port}`;
    for (const host of ["127.0.0.1", "localhost"]) {
      const result = await runTool(
        {
          id: host,
          name: "fetch",
          arguments: JSON.stringify({
            url: `http://${host}:${server.port}/props`,
          }),
        },
        context(engine),
      );
      expect(result.error).not.toBeNull();
      expect(result.text).toStartWith("Error: ");
    }
    await Bun.sleep(10);
    expect(requests).toBe(0);
  });
});

describe("fetch address fallback", () => {
  test("tries IPv4 before IPv6 and the next address on a socket error", async () => {
    const tried: string[] = [];
    const deps = dependencies(
      (input) => {
        tried.push(new URL(input).hostname);
        if (tried.length === 1) {
          const error = new Error("Was there a typo in the url or port?");
          (error as { code?: string }).code = "FailedToOpenSocket";
          throw error;
        }
        return textResponse();
      },
      { "dual.example": ["2606:4700::1", "93.184.216.34", "1.1.1.1"] },
    );
    await fetchText({ url: "http://dual.example/" }, context(), deps);
    expect(tried).toEqual(["93.184.216.34", "1.1.1.1"]);
  });

  test("names the host when no address connects", async () => {
    const deps = dependencies(
      () => {
        const error = new Error("Was there a typo in the url or port?");
        (error as { code?: string }).code = "FailedToOpenSocket";
        throw error;
      },
      { "down.example": ["93.184.216.34", "2606:4700::1"] },
    );
    await expect(
      fetchText({ url: "http://down.example/" }, context(), deps),
    ).rejects.toThrow("could not connect to down.example (2 addresses tried)");
  });
});
