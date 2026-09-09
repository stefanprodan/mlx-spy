import { describe, expect, test } from "bun:test";
import { ChatRunner } from "../src/chat.ts";
import { ChatStore } from "../src/chats.ts";
import type {
  CacheLimits,
  Capability,
  ChatEvent,
  ChatRequest,
  Engine,
  EngineMetrics,
  ModelInfo,
} from "../src/engine/types.ts";
import { History } from "../src/history.ts";
import { PullError } from "../src/pull.ts";
import { TOOLS } from "../src/tools.ts";
import { handle, snapshot, type WebDeps } from "../src/web.ts";

const MODEL = "org/model";
const model: ModelInfo = {
  id: MODEL,
  loaded: true,
  state: "ready",
  bytesResident: 1,
  bytesOnDisk: 1,
  contextLength: 1000,
  capabilities: ["chat"],
};

class WebEngine implements Engine {
  readonly id = "mlxserve" as const;
  readonly url = "http://fake";
  signals: AbortSignal[] = [];

  async *chat(
    _req: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatEvent> {
    this.signals.push(signal);
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  async health() {
    return true;
  }
  async models() {
    return [model];
  }
  async metrics(): Promise<EngineMetrics> {
    throw new Error("unused");
  }
  async load() {}
  async unload() {}
  capabilities(): Set<Capability> {
    return new Set(["chat"]);
  }
  cacheDirs() {
    return [];
  }
  logFile() {
    return null;
  }
  processNames() {
    return [];
  }
  serviceLabel() {
    return null;
  }
  async cacheLimits(): Promise<CacheLimits | null> {
    return null;
  }
}

function setup() {
  const engine = new WebEngine();
  const history = new History(":memory:");
  const store = new ChatStore(history.db, Date.now, () =>
    TOOLS.map((tool) => tool.name),
  );
  const chat = new ChatRunner({
    engine,
    store,
    models: () => [model],
    log() {},
  });
  const sampler = {
    currentModels: () => [model],
    currentDisk: () => [],
    onSample: () => () => {},
  };
  const actions = {
    events: [],
    running: () => null,
    onEvent: () => () => {},
  };
  const deps = {
    engine,
    history,
    chat,
    sampler,
    actions,
    version: "vtest",
    local: true,
    limits: null,
    host: null,
  } as unknown as WebDeps;
  return { engine, history, chat, deps };
}

function request(
  path: string,
  method = "GET",
  value?: unknown,
  origin?: string,
) {
  const headers = new Headers();
  headers.set("host", "x");
  if (origin) headers.set("origin", origin);
  if (value !== undefined) headers.set("content-type", "application/json");
  return new Request(`http://x${path}`, {
    method,
    headers,
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}

async function response(
  deps: WebDeps,
  path: string,
  method = "GET",
  value?: unknown,
  origin?: string,
) {
  const result = await handle(request(path, method, value, origin), deps);
  expect(result.headers.get("cache-control")).toBe("no-store");
  return result;
}

// A runner with the surface the routes use; the real one is tested in
// test/pull.test.ts.
function fakePulls() {
  const calls: string[] = [];
  const pull = {
    id: 3,
    repo: "org/new",
    revision: "abc",
    dir: "/m/org/new",
    status: "queued" as const,
    bytesTotal: 10,
    bytesDone: 0,
    filesTotal: 1,
    filesDone: 0,
    file: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    finishedAt: null,
    speedBps: null,
  };
  return {
    calls,
    pull,
    list: () => [pull],
    get: (id: number) => (id === 3 ? pull : null),
    async start(repo: string) {
      calls.push(`start ${repo}`);
      if (repo === "bad") throw new PullError(400, "repo must be x");
      return pull;
    },
    async cancel(id: number) {
      calls.push(`cancel ${id}`);
      if (id !== 3) throw new PullError(404, "Pull not found");
      return { ...pull, status: "cancelled" };
    },
    async remove(id: number) {
      calls.push(`remove ${id}`);
      if (id !== 3) throw new PullError(404, "Pull not found");
    },
    onEvent: () => () => {},
  };
}

describe("pulls API", () => {
  test("lists, starts, reads, cancels and forgets downloads", async () => {
    const s = setup();
    const runner = fakePulls();
    const deps = {
      ...s.deps,
      pulls: runner,
      modelDir: "/m",
    } as unknown as WebDeps;
    expect(snapshot(deps).pulls).toEqual([runner.pull]);
    expect(snapshot(deps).modelDir).toBe("/m");
    expect(snapshot(s.deps).pulls).toEqual([]);
    expect(snapshot(s.deps).modelDir).toBeNull();

    const list = await response(deps, "/api/pulls");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([runner.pull]);

    const started = await response(deps, "/api/pulls", "POST", {
      repo: "org/new",
    });
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual(runner.pull);
    const refused = await response(deps, "/api/pulls", "POST", {
      repo: "bad",
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "repo must be x" });
    expect(
      (await response(deps, "/api/pulls", "POST", { repo: 1 })).status,
    ).toBe(400);
    expect((await response(deps, "/api/pulls", "POST", {})).status).toBe(400);

    expect((await response(deps, "/api/pulls/3")).status).toBe(200);
    expect((await response(deps, "/api/pulls/4")).status).toBe(404);

    const cancelled = await response(deps, "/api/pulls/3/cancel", "POST");
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as any).status).toBe("cancelled");
    expect((await response(deps, "/api/pulls/4/cancel", "POST")).status).toBe(
      404,
    );
    expect((await response(deps, "/api/pulls/3/cancel")).status).toBe(405);

    const removed = await response(deps, "/api/pulls/3", "DELETE");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect((await response(deps, "/api/pulls/4", "DELETE")).status).toBe(404);
    expect((await response(deps, "/api/pulls/x")).status).toBe(404);
    expect((await response(deps, "/api/pulls/3", "PATCH")).status).toBe(405);
    expect(
      (
        await response(
          deps,
          "/api/pulls",
          "POST",
          { repo: "a/b" },
          "http://evil",
        )
      ).status,
    ).toBe(403);
    // without a runner the routes do not exist
    expect((await response(s.deps, "/api/pulls")).status).toBe(404);
    expect(runner.calls).toEqual([
      "start org/new",
      "start bad",
      "cancel 3",
      "cancel 4",
      "remove 3",
      "remove 4",
    ]);
    s.history.close();
  });
});

describe("chat API", () => {
  test("creates, lists, reads, updates and deletes chats", async () => {
    const s = setup();
    const created = await response(s.deps, "/api/chats", "POST", {
      model: MODEL,
      title: "test",
      systemPrompt: "system",
      thinking: false,
      reasoningEffort: "none",
      temperature: 0,
      topP: 1,
      maxTokens: 20,
      search: "firecrawl",
    });
    expect(created.status).toBe(201);
    const chat = (await created.json()) as any;
    expect(chat).toMatchObject({
      title: "test",
      model: MODEL,
      systemPrompt: "system",
      thinking: false,
      reasoningEffort: "none",
      temperature: 0,
      topP: 1,
      maxTokens: 20,
      search: "firecrawl",
      messages: [],
    });

    const list = await response(s.deps, "/api/chats");
    expect(await list.json()).toEqual([
      {
        id: chat.id,
        title: "test",
        model: MODEL,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        streaming: false,
      },
    ]);
    expect((await response(s.deps, `/api/chats/${chat.id}`)).status).toBe(200);

    const patched = await response(s.deps, `/api/chats/${chat.id}`, "PATCH", {
      title: "changed",
      thinking: true,
      reasoningEffort: null,
      temperature: 2,
      topP: 0,
      maxTokens: null,
    });
    expect(await patched.json()).toMatchObject({
      title: "changed",
      thinking: true,
      reasoningEffort: null,
      temperature: 2,
      topP: 0,
      maxTokens: null,
      search: "firecrawl",
    });

    const removed = await response(s.deps, `/api/chats/${chat.id}`, "DELETE");
    expect(await removed.json()).toEqual({ ok: true });
    expect((await response(s.deps, `/api/chats/${chat.id}`)).status).toBe(404);
    s.history.close();
  });

  test("sends, reports global conflicts, stops, regenerates and edits", async () => {
    const s = setup();
    const created = await response(s.deps, "/api/chats", "POST", {
      model: MODEL,
    });
    const chat = (await created.json()) as any;
    expect(chat.search).toBe("exa");
    const sent = await response(
      s.deps,
      `/api/chats/${chat.id}/messages`,
      "POST",
      { content: "hello" },
    );
    expect(sent.status).toBe(202);
    const rows = (await sent.json()) as any;
    expect(rows.user.content).toBe("hello");
    expect(rows.message.status).toBe("streaming");
    expect(snapshot(s.deps).chat).toEqual({
      chatId: chat.id,
      messageId: rows.message.id,
    });

    const conflict = await response(
      s.deps,
      `/api/chats/${chat.id}/messages`,
      "POST",
      { content: "again" },
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: expect.any(String) });

    const stopped = await response(
      s.deps,
      `/api/chats/${chat.id}/stop`,
      "POST",
    );
    expect(await stopped.json()).toEqual({ ok: true });
    expect(snapshot(s.deps).chat).toBeNull();

    const regenerated = await response(
      s.deps,
      `/api/chats/${chat.id}/regenerate`,
      "POST",
    );
    expect(regenerated.status).toBe(202);
    await response(s.deps, `/api/chats/${chat.id}/stop`, "POST");

    const edited = await response(
      s.deps,
      `/api/chats/${chat.id}/edit`,
      "POST",
      { messageId: rows.user.id, content: "edited" },
    );
    expect(edited.status).toBe(202);
    expect(((await edited.json()) as any).user.content).toBe("edited");
    await response(s.deps, `/api/chats/${chat.id}/stop`, "POST");
    s.history.close();
  });

  test("validates 404s, model/settings/content, body size and origin", async () => {
    const s = setup();
    expect((await response(s.deps, "/api/chats/missing")).status).toBe(404);
    expect(
      (await response(s.deps, "/api/chats", "POST", { model: "no/model" }))
        .status,
    ).toBe(400);
    expect(
      (
        await response(s.deps, "/api/chats", "POST", {
          model: MODEL,
          temperature: 3,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await response(s.deps, "/api/chats", "POST", {
          model: MODEL,
          reasoningEffort: "extreme",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await response(
          s.deps,
          "/api/chats",
          "POST",
          { model: MODEL },
          "http://evil.example",
        )
      ).status,
    ).toBe(403);

    const created = await response(s.deps, "/api/chats", "POST", {
      model: MODEL,
    });
    const chat = (await created.json()) as any;
    expect(
      (
        await response(s.deps, `/api/chats/${chat.id}/messages`, "POST", {
          content: "",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await response(s.deps, `/api/chats/${chat.id}/edit`, "POST", {
          messageId: "x",
          content: "text",
        })
      ).status,
    ).toBe(400);
    const oversized = request(`/api/chats/${chat.id}/messages`, "POST", {
      content: "x".repeat(256 * 1024),
    });
    expect((await handle(oversized, s.deps)).status).toBe(400);
    s.history.close();
  });

  test("validates the search provider on create and patch", async () => {
    const s = setup();
    for (const search of ["bing", null, 1]) {
      expect(
        (
          await response(s.deps, "/api/chats", "POST", {
            model: MODEL,
            search,
          })
        ).status,
      ).toBe(400);
    }
    const created = await response(s.deps, "/api/chats", "POST", {
      model: MODEL,
      search: "exa",
    });
    const chat = (await created.json()) as any;
    const patched = await response(s.deps, `/api/chats/${chat.id}`, "PATCH", {
      search: "firecrawl",
    });
    expect(((await patched.json()) as any).search).toBe("firecrawl");
    for (const search of ["bing", null, 1]) {
      expect(
        (
          await response(s.deps, `/api/chats/${chat.id}`, "PATCH", {
            search,
          })
        ).status,
      ).toBe(400);
    }
    s.history.close();
  });

  test("lists tools without caching", async () => {
    const s = setup();
    const result = await response(s.deps, "/api/tools");
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual([
      {
        name: "get_current_time",
        description: expect.any(String),
      },
      {
        name: "webfetch",
        description: expect.any(String),
      },
      {
        name: "websearch",
        description: expect.any(String),
      },
    ]);
    s.history.close();
  });

  test("accepts known toolsOff names and rejects unknown names", async () => {
    const s = setup();
    const created = await response(s.deps, "/api/chats", "POST", {
      model: MODEL,
      toolsOff: ["get_current_time"],
    });
    const chat = (await created.json()) as any;
    expect(chat.toolsOff).toEqual(["get_current_time"]);
    const patched = await response(s.deps, `/api/chats/${chat.id}`, "PATCH", {
      toolsOff: [],
    });
    expect(((await patched.json()) as any).toolsOff).toEqual([]);
    expect(
      (
        await response(s.deps, "/api/chats", "POST", {
          model: MODEL,
          toolsOff: ["missing"],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await response(s.deps, `/api/chats/${chat.id}`, "PATCH", {
          toolsOff: "get_current_time",
        })
      ).status,
    ).toBe(400);
    s.history.close();
  });

  test("rejects model, toolsOff and search patches during a send", async () => {
    const s = setup();
    const created = await response(s.deps, "/api/chats", "POST", {
      model: MODEL,
    });
    const chat = (await created.json()) as any;
    await response(s.deps, `/api/chats/${chat.id}/messages`, "POST", {
      content: "hello",
    });
    expect(
      (
        await response(s.deps, `/api/chats/${chat.id}`, "PATCH", {
          model: MODEL,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await response(s.deps, `/api/chats/${chat.id}`, "PATCH", {
          toolsOff: ["get_current_time"],
        })
      ).status,
    ).toBe(409);
    const searchConflict = await response(
      s.deps,
      `/api/chats/${chat.id}`,
      "PATCH",
      { search: "firecrawl" },
    );
    expect(searchConflict.status).toBe(409);
    expect(await searchConflict.json()).toEqual({
      error: "Model, tools and search cannot change during a send",
    });
    expect(
      (
        await response(s.deps, `/api/chats/${chat.id}`, "PATCH", {
          title: "allowed",
        })
      ).status,
    ).toBe(200);
    await response(s.deps, `/api/chats/${chat.id}/stop`, "POST");
    await Bun.sleep(0);
    s.history.close();
  });
});
