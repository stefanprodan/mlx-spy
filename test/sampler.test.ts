import { describe, expect, test } from "bun:test";
import { Actions } from "../src/actions.ts";
import { parseMetrics, parseModels } from "../src/engine/mlxserve.ts";
import type {
  Capability,
  Engine,
  EngineMetrics,
  ModelInfo,
} from "../src/engine/types.ts";
import { History } from "../src/history.ts";
import type { HostProbes } from "../src/host/types.ts";
import { Sampler } from "../src/sampler.ts";
import { handle, isRange, snapshot } from "../src/web.ts";
import metricsFixture from "./fixtures/metrics.json";
import modelsFixture from "./fixtures/models.json";

// A scripted engine: each metrics() call pops the next body (a function of
// the fixture), or throws when the script says the engine is down.
type Step = ((body: any) => void) | "down";

class FakeEngine implements Engine {
  readonly id = "mlxserve" as const;
  readonly url = "http://fake:11234";
  metricsCalls = 0;
  modelsCalls = 0;
  constructor(private readonly steps: Step[]) {}
  async health() {
    return true;
  }
  async models(): Promise<ModelInfo[]> {
    this.modelsCalls++;
    return parseModels(modelsFixture);
  }
  async metrics(): Promise<EngineMetrics> {
    this.metricsCalls++;
    const step = this.steps.shift();
    if (step === undefined) throw new Error("script exhausted");
    if (step === "down") throw new Error("connection refused");
    const body = structuredClone(metricsFixture) as any;
    step(body);
    return parseMetrics(body);
  }
  async load() {}
  async unload() {}
  capabilities(): Set<Capability> {
    return new Set();
  }
  cacheDirs() {
    return [];
  }
  logFile() {
    return null;
  }
  processNames() {
    return ["fake-engine"];
  }
  serviceLabel() {
    return null;
  }
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const idle = () => {};

describe("Sampler", () => {
  test("first tick fetches models and has no rates; second has a window", async () => {
    const engine = new FakeEngine([idle, idle]);
    const history = new History(":memory:");
    const c = clock();
    const s = new Sampler(engine, history, { now: c.now });
    const a = await s.tick();
    expect(a?.engineUp).toBe(true);
    expect(a?.windowMs).toBeNull();
    expect(a?.models).toHaveLength(3);
    expect(engine.modelsCalls).toBe(1);
    c.advance(1000);
    const b = await s.tick();
    expect(b?.windowMs).toBe(1000);
    expect(b?.decodeTps).toBe(0);
    expect(engine.modelsCalls).toBe(1); // carried between refreshes
    expect(history.count()).toBe(2);
    history.close();
  });

  test("decode tok/s from the live gauge across ticks", async () => {
    const engine = new FakeEngine([
      (b) => {
        b.gauges.generation_tokens_live = 0;
      },
      (b) => {
        b.gauges.generation_tokens_live = 45;
        b.gauges.requests_running = 1;
      },
    ]);
    const history = new History(":memory:");
    const c = clock();
    const s = new Sampler(engine, history, { now: c.now });
    await s.tick();
    c.advance(1500);
    const b = await s.tick();
    expect(b?.decodeTps).toBe(30);
    expect(b?.requestsRunning).toBe(1);
    history.close();
  });

  test("a counter reset bumps the epoch, logs, and persists", async () => {
    const engine = new FakeEngine([
      idle,
      (b) => {
        b.counters.prompt_tokens_total = 5;
        b.counters.requests_success_total = 0;
      },
      idle,
    ]);
    const history = new History(":memory:");
    const lines: string[] = [];
    const c = clock();
    const s = new Sampler(engine, history, {
      now: c.now,
      log: (l) => lines.push(l),
    });
    await s.tick();
    c.advance(1000);
    const b = await s.tick();
    expect(b?.epoch).toBe(1);
    expect(b?.windowMs).toBeNull();
    expect(lines).toEqual(["engine counters reset: epoch 0 -> 1"]);
    c.advance(1000);
    const d = await s.tick();
    expect(d?.epoch).toBe(1);
    expect(d?.windowMs).toBe(1000);
    expect(history.loadSamplerState().epoch).toBe(1);
    history.close();
  });

  test("a restart of mlx-spy still detects an engine restart", async () => {
    const history = new History(":memory:");
    // previous mlx-spy run saw these counters and was on epoch 2
    history.saveSamplerState({
      epoch: 2,
      counters: parseMetrics(metricsFixture).counters,
    });
    const engine = new FakeEngine([
      (b) => {
        b.counters.generation_tokens_total = 1; // below the saved 26
      },
      idle,
    ]);
    const c = clock();
    const s = new Sampler(engine, history, { now: c.now });
    const a = await s.tick();
    expect(a?.epoch).toBe(3);
    c.advance(1000);
    const b = await s.tick();
    expect(b?.epoch).toBe(3);
    expect(b?.windowMs).toBe(1000);
    history.close();
  });

  test("a restart with unchanged counters keeps the epoch and no rates", async () => {
    const history = new History(":memory:");
    history.saveSamplerState({
      epoch: 2,
      counters: parseMetrics(metricsFixture).counters,
    });
    const engine = new FakeEngine([idle]);
    const s = new Sampler(engine, history, { now: clock().now });
    const a = await s.tick();
    expect(a?.epoch).toBe(2);
    // the restored reading has no timestamp or gauges: no window to rate over
    expect(a?.windowMs).toBeNull();
    expect(a?.decodeTps).toBeNull();
    history.close();
  });

  test("engine down yields engineUp=false and restarts the window", async () => {
    const engine = new FakeEngine([idle, "down", idle, idle]);
    const history = new History(":memory:");
    const c = clock();
    const s = new Sampler(engine, history, { now: c.now });
    await s.tick();
    c.advance(1000);
    const down = await s.tick();
    expect(down?.engineUp).toBe(false);
    expect(down?.models).toEqual([]);
    c.advance(1000);
    const back = await s.tick();
    expect(back?.engineUp).toBe(true);
    expect(back?.windowMs).toBeNull();
    c.advance(1000);
    expect((await s.tick())?.windowMs).toBe(1000);
    expect(history.count()).toBe(4);
    history.close();
  });

  test("listeners get every sample", async () => {
    const engine = new FakeEngine([idle, idle]);
    const history = new History(":memory:");
    const s = new Sampler(engine, history, { now: clock().now });
    const seen: number[] = [];
    const off = s.onSample((x) => seen.push(x.t));
    await s.tick();
    off();
    await s.tick();
    expect(seen).toHaveLength(1);
    history.close();
  });
});

describe("web", () => {
  async function deps() {
    const engine = new FakeEngine([idle, idle]);
    const history = new History(":memory:");
    const c = clock();
    const sampler = new Sampler(engine, history, { now: c.now });
    await sampler.tick();
    c.advance(1000);
    await sampler.tick();
    const actions = new Actions({ engine, sampler, local: false, log() {} });
    return {
      engine,
      sampler,
      history,
      actions,
      version: "vtest",
      local: false,
      now: c.now,
    };
  }

  test("snapshot carries the latest sample and models", async () => {
    const d = await deps();
    const snap = snapshot(d);
    expect(snap.version).toBe("vtest");
    expect(snap.engine).toEqual({
      id: "mlxserve",
      url: "http://fake:11234",
      local: false,
      capabilities: [],
    });
    expect(snap.disk).toEqual([]);
    expect(snap.sample?.windowMs).toBe(1000);
    expect(snap.models).toHaveLength(3);
    d.history.close();
  });

  test("routes", async () => {
    const d = await deps();
    const get = (p: string) => handle(new Request(`http://x${p}`), d);
    expect((await get("/api/snapshot")).status).toBe(200);
    const h = await get("/api/history?range=1h");
    expect(h.status).toBe(200);
    const body = (await h.json()) as any;
    expect(body.range).toBe("1h");
    expect(body.series.t).toHaveLength(2);
    expect((await get("/api/history")).status).toBe(200);
    expect((await get("/api/history?range=2h")).status).toBe(400);
    expect((await get("/nope")).status).toBe(404);
    expect(
      (
        await handle(
          new Request("http://x/api/snapshot", { method: "POST" }),
          d,
        )
      ).status,
    ).toBe(405);
    expect((await get("/api/actions/free")).status).toBe(405);
    d.history.close();
  });

  test("isRange", () => {
    expect(isRange("7d")).toBe(true);
    expect(isRange("2d")).toBe(false);
    expect(isRange(null)).toBe(false);
  });
});

describe("Sampler host probes", () => {
  function fakeProbes(
    pids: Map<number, string>,
  ): HostProbes & { scans: number } {
    return {
      scans: 0,
      hostMemory: () => ({
        total: 1000,
        free: 100,
        active: 400,
        inactive: 200,
        wired: 300,
        speculative: 0,
        compressed: 50,
      }),
      processMemory: (pid) =>
        pids.has(pid) ? { footprint: pid * 10, rss: pid * 9 } : null,
      findPid(names) {
        this.scans++;
        for (const [pid, name] of pids) if (names.includes(name)) return pid;
        return null;
      },
      pidMatches: (pid, names) => names.includes(pids.get(pid) ?? ""),
    };
  }

  test("remote engine: host memory only, no pid, engine's own footprint", async () => {
    const engine = new FakeEngine([idle]);
    const history = new History(":memory:");
    const probes = fakeProbes(new Map([[42, "fake-engine"]]));
    const s = new Sampler(engine, history, {
      now: clock().now,
      probes,
      local: false,
    });
    const a = (await s.tick())!;
    expect(a.mem.hostFree).toBe(100);
    expect(a.mem.hostCompressed).toBe(50);
    expect(a.enginePid).toBeNull();
    expect(a.mem.procFootprint).toBe(39439 * 1024 * 1024);
    expect(a.mem.procRss).toBe(0);
    expect(probes.scans).toBe(0);
    history.close();
  });

  test("local engine: pid found, rusage footprint, rescan on exit", async () => {
    const engine = new FakeEngine([idle, idle, idle, idle, idle, idle, idle]);
    const history = new History(":memory:");
    const pids = new Map([[42, "fake-engine"]]);
    const probes = fakeProbes(pids);
    const lines: string[] = [];
    const c = clock();
    const s = new Sampler(engine, history, {
      now: c.now,
      probes,
      local: true,
      log: (l) => lines.push(l),
    });
    const a = (await s.tick())!;
    expect(a.enginePid).toBe(42);
    expect(a.mem.procFootprint).toBe(420);
    expect(a.mem.procRss).toBe(378);
    expect(probes.scans).toBe(1);
    expect(lines).toEqual(["engine pid none -> 42"]);
    // the engine process restarts: old pid gone
    pids.clear();
    c.advance(1000);
    const b = (await s.tick())!;
    expect(b.enginePid).toBeNull();
    expect(b.mem.procFootprint).toBe(39439 * 1024 * 1024);
    // new pid appears; found on the next scan interval
    pids.set(77, "fake-engine");
    c.advance(1000);
    const d = (await s.tick())!;
    expect(d.enginePid).toBe(77);
    expect(d.mem.procFootprint).toBe(770);
    expect(lines.at(-1)).toBe("engine pid none -> 77");
    history.close();
  });

  test("engine down still carries host memory and disk", async () => {
    const engine = new FakeEngine(["down"]);
    const history = new History(":memory:");
    const s = new Sampler(engine, history, {
      now: clock().now,
      probes: fakeProbes(new Map()),
      local: true,
    });
    await s.settle();
    const a = (await s.tick())!;
    expect(a.engineUp).toBe(false);
    expect(a.mem.hostTotal).toBe(1000);
    expect(a.disk).toEqual([]);
    history.close();
  });
});
