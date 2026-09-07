import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionError,
  type ActionEvent,
  Actions,
  clearDirContents,
} from "../src/actions.ts";
import { parseMetrics, parseModels } from "../src/engine/mlxserve.ts";
import type {
  Capability,
  Engine,
  EngineMetrics,
  ModelInfo,
} from "../src/engine/types.ts";
import { History } from "../src/history.ts";
import { Sampler } from "../src/sampler.ts";
import { handle } from "../src/web.ts";
import metricsFixture from "./fixtures/metrics.json";
import modelsFixture from "./fixtures/models.json";

const QWEN = "Jundot/Qwen3.8-27B-oQ4e-mtp";
const APODEX = "stefanprodan/Apodex-1.1-mini-oQ4e-mtp";

// An engine whose load/unload mutate its model list, as mlx-serve does.
class ControlEngine implements Engine {
  readonly id = "mlxserve" as const;
  readonly url = "http://fake:11234";
  list: ModelInfo[] = parseModels(modelsFixture);
  calls: string[] = [];
  failNext: string | null = null;
  caps: Set<Capability> = new Set([
    "load",
    "unload",
    "default",
    "restart",
    "diskClear",
  ]);
  label: string | null = "com.fake.engine";
  dirs: string[] = [];

  async health() {
    return true;
  }
  async models(): Promise<ModelInfo[]> {
    return structuredClone(this.list);
  }
  async metrics(): Promise<EngineMetrics> {
    return parseMetrics(metricsFixture);
  }
  private set(id: string, loaded: boolean) {
    const m = this.list.find((m) => m.id === id)!;
    m.loaded = loaded;
    m.state = loaded ? "ready" : "unloaded";
  }
  async load(id: string, asDefault: boolean) {
    this.calls.push(`load ${id} ${asDefault}`);
    if (this.failNext) throw new Error(this.failNext);
    this.set(id, true);
  }
  async unload(id: string) {
    this.calls.push(`unload ${id}`);
    if (this.failNext) throw new Error(this.failNext);
    this.set(id, false);
  }
  capabilities() {
    return this.caps;
  }
  cacheDirs() {
    return this.dirs;
  }
  logFile() {
    return null;
  }
  processNames() {
    return ["fake-engine"];
  }
  serviceLabel() {
    return this.label;
  }
}

async function setup(local = true) {
  const engine = new ControlEngine();
  const history = new History(":memory:");
  const sampler = new Sampler(engine, history, { now: () => 1000 });
  await sampler.tick();
  const logs: string[] = [];
  const spawned: string[][] = [];
  const cleared: string[] = [];
  const actions = new Actions({
    engine,
    sampler,
    local,
    log: (l) => logs.push(l),
    uid: 501,
    now: () => 5000,
    spawn: async (cmd) => {
      spawned.push(cmd);
      return { code: 0, stderr: "" };
    },
    clearDir: async (root) => {
      cleared.push(root);
      return 2;
    },
  });
  return { engine, history, sampler, actions, logs, spawned, cleared };
}

const rejects = async (p: Promise<unknown>, status: number, re: RegExp) => {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(ActionError);
  expect((err as ActionError).status).toBe(status);
  expect((err as ActionError).message).toMatch(re);
};

describe("Actions", () => {
  test("unload goes through the adapter, refreshes models, logs", async () => {
    const s = await setup();
    const events: ActionEvent[] = [];
    s.actions.onEvent((e) => events.push(e));
    const ev = await s.actions.run("unload", { model: QWEN });
    expect(ev).toMatchObject({ action: "unload", model: QWEN, ok: true });
    expect(s.engine.calls).toEqual([`unload ${QWEN}`]);
    expect(s.sampler.currentModels().find((m) => m.id === QWEN)?.loaded).toBe(
      false,
    );
    expect(events).toEqual([ev]);
    expect(s.actions.events).toEqual([ev]);
    expect(s.logs).toEqual([`action unload ${QWEN}: ok in 0 ms (unloaded)`]);
    s.history.close();
  });

  test("load and default", async () => {
    const s = await setup();
    await s.actions.run("load", { model: APODEX });
    await s.actions.run("default", { model: QWEN });
    expect(s.engine.calls).toEqual([
      `load ${APODEX} false`,
      `load ${QWEN} true`,
    ]);
    s.history.close();
  });

  test("model ids must name a listed model", async () => {
    const s = await setup();
    await rejects(s.actions.run("load", {}), 400, /needs a model id/);
    await rejects(
      s.actions.run("load", { model: "x/y" }),
      400,
      /unknown model/,
    );
    await rejects(
      s.actions.run("unload", { model: APODEX }),
      400,
      /not loaded/,
    );
    await rejects(s.actions.run("nuke", {}), 404, /unknown action/);
    expect(s.engine.calls).toEqual([]);
    s.history.close();
  });

  test("capabilities gate the actions", async () => {
    const s = await setup();
    s.engine.caps = new Set(["load"]);
    await rejects(s.actions.run("unload", { model: QWEN }), 403, /cannot/);
    await rejects(s.actions.run("free", {}), 403, /cannot free/);
    s.history.close();
  });

  test("free and diskClear need a local engine", async () => {
    const s = await setup(false);
    await rejects(s.actions.run("free", {}), 403, /on this host/);
    await rejects(s.actions.run("diskClear", {}), 403, /on this host/);
    // adapter actions still work remotely
    await s.actions.run("unload", { model: QWEN });
    expect(s.spawned).toEqual([]);
    s.history.close();
  });

  test("free runs launchctl kickstart -k on the service label", async () => {
    const s = await setup();
    const ev = await s.actions.run("free", {});
    expect(s.spawned).toEqual([
      ["launchctl", "kickstart", "-k", "gui/501/com.fake.engine"],
    ]);
    expect(ev.detail).toBe("restarted com.fake.engine");
    s.history.close();
  });

  test("free without a service label is refused", async () => {
    const s = await setup();
    s.engine.label = null;
    await rejects(s.actions.run("free", {}), 502, /not a launchd service/);
    expect(s.spawned).toEqual([]);
    s.history.close();
  });

  test("diskClear restarts first, then wipes only the adapter's dirs", async () => {
    const s = await setup();
    s.engine.dirs = ["/tmp/a", "/tmp/b"];
    const ev = await s.actions.run("diskClear", { path: "/" });
    expect(s.spawned).toHaveLength(1);
    expect(s.cleared).toEqual(["/tmp/a", "/tmp/b"]);
    expect(ev.detail).toBe("restarted, removed 4 cache dirs");
    s.history.close();
  });

  test("a failed spawn is a 502 with the exit code", async () => {
    const s = await setup();
    const actions = new Actions({
      engine: s.engine,
      sampler: s.sampler,
      local: true,
      log() {},
      spawn: async () => ({ code: 3, stderr: "no such service" }),
    });
    await rejects(actions.run("free", {}), 502, /exited 3: no such service/);
    expect(actions.events[0]).toMatchObject({ ok: false, action: "free" });
    s.history.close();
  });

  test("an engine error is logged and answered 502", async () => {
    const s = await setup();
    s.engine.failNext = "HTTP 500 out of memory";
    await rejects(s.actions.run("load", { model: APODEX }), 502, /HTTP 500/);
    expect(s.logs[0]).toMatch(/failed in 0 ms \(HTTP 500 out of memory\)/);
    s.history.close();
  });

  test("one action at a time", async () => {
    const s = await setup();
    let release!: () => void;
    s.engine.load = () =>
      new Promise((r) => {
        release = r;
      });
    const first = s.actions.run("load", { model: APODEX });
    await Bun.sleep(0);
    expect(s.actions.running()).toBe("load");
    await rejects(
      s.actions.run("unload", { model: QWEN }),
      409,
      /load is still running/,
    );
    release();
    await first;
    expect(s.actions.running()).toBeNull();
    s.history.close();
  });

  test("the route answers with the action's status", async () => {
    const s = await setup();
    const deps = {
      engine: s.engine,
      sampler: s.sampler,
      history: s.history,
      actions: s.actions,
      version: "vtest",
      local: true,
    };
    const post = (name: string, body?: unknown) =>
      handle(
        new Request(`http://x/api/actions/${name}`, {
          method: "POST",
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        deps,
      );
    const ok = await post("unload", { model: QWEN });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as ActionEvent).ok).toBe(true);
    expect((await post("free")).status).toBe(200);
    expect((await post("load", { model: "nope" })).status).toBe(400);
    expect((await post("bogus")).status).toBe(404);
    const snap = await handle(new Request("http://x/api/snapshot"), deps);
    expect(((await snap.json()) as any).events).toHaveLength(2);
    s.history.close();
  });
});

describe("clearDirContents", () => {
  test("removes children, keeps the root, tolerates a missing root", async () => {
    const root = await mkdtemp(join(tmpdir(), "mlx-spy-cache-"));
    await writeFile(join(root, "a"), "x");
    await Bun.write(join(root, "fp1", "shard"), "y");
    expect(await clearDirContents(root)).toBe(2);
    expect(await readdir(root)).toEqual([]);
    expect(await clearDirContents(join(root, "missing"))).toBe(0);
  });
});
