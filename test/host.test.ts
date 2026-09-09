import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { createDarwinProbes, darwinHostInfo } from "../src/host/darwin.ts";
import { cacheDirSizes } from "../src/host/disk.ts";
import { NULL_PROBES } from "../src/host/index.ts";
import { isLocalUrl } from "../src/host/local.ts";

const onDarwin = process.platform === "darwin";

const positiveOptional = (value: number | null) => value === null || value > 0;

describe.if(onDarwin)("darwin probes", () => {
  const p = createDarwinProbes();

  test("host memory returns plausible page counts", () => {
    const m = p.hostMemory();
    expect(m).not.toBeNull();
    expect(m!.total).toBeGreaterThan(1024 ** 3);

    const pageValues = [
      m!.free,
      m!.active,
      m!.inactive,
      m!.wired,
      m!.speculative,
      m!.compressed,
    ];
    for (const value of pageValues) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value % 16384).toBe(0);
    }

    const accounted = m!.free + m!.active + m!.inactive + m!.wired;
    expect(accounted).toBeGreaterThan(0);
    expect(accounted).toBeLessThanOrEqual(m!.total);
  });

  test("process memory describes this process", () => {
    const pm = p.processMemory(process.pid);
    expect(pm).not.toBeNull();
    expect(pm!.footprint).toBeGreaterThan(1024 * 1024);
    expect(pm!.rss).toBeGreaterThan(1024 * 1024);

    const expectedStart = Date.now() - process.uptime() * 1000;
    expect(Math.abs(pm!.startedAt - expectedStart)).toBeLessThan(1000);

    expect(Number.isFinite(pm!.cpuNs)).toBe(true);
    expect(pm!.cpuNs).toBeGreaterThan(0);
    const maxCpuNs = (process.uptime() + 1) * 1e9 * Math.max(cpus().length, 1);
    expect(pm!.cpuNs).toBeLessThanOrEqual(maxCpuNs);
  });

  test("process memory of a dead pid is null", () => {
    expect(p.processMemory(2 ** 30)).toBeNull();
  });

  test("pid matching uses executable basenames", () => {
    expect(p.pidMatches(process.pid, ["bun"])).toBe(true);
    expect(p.pidMatches(process.pid, ["mlx-serve"])).toBe(false);

    const pid = p.findPid(["bun"]);
    expect(pid).not.toBeNull();
    expect(p.pidMatches(pid!, ["bun"])).toBe(true);
    expect(p.findPid(["no-such-binary-xyz"])).toBeNull();
  });

  test("host info returns required and optional values", () => {
    const info = darwinHostInfo();
    expect(info.cpuCores).toBe(cpus().length);
    expect(info.chip === null || info.chip.trim().length > 0).toBe(true);
    expect(positiveOptional(info.perfCores)).toBe(true);
    expect(positiveOptional(info.effCores)).toBe(true);
    expect(positiveOptional(info.gpuCores)).toBe(true);
  });
});

describe("null probes", () => {
  test("return no host or process data", () => {
    expect(NULL_PROBES.hostMemory()).toBeNull();
    expect(NULL_PROBES.processMemory(process.pid)).toBeNull();
    expect(NULL_PROBES.findPid(["bun"])).toBeNull();
    expect(NULL_PROBES.pidMatches(process.pid, ["bun"])).toBe(false);
  });
});

describe("cacheDirSizes", () => {
  test("one entry per child dir, allocated bytes, links skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "mlx-spy-disk-"));
    try {
      mkdirSync(join(root, "fp-a", "deep"), { recursive: true });
      mkdirSync(join(root, "fp-b"));
      writeFileSync(join(root, "fp-a", "x.bin"), Buffer.alloc(100_000, 1));
      writeFileSync(join(root, "fp-a", "deep", "y.bin"), Buffer.alloc(4096, 1));
      writeFileSync(join(root, "stray.txt"), "not a dir");
      symlinkSync(join(root, "fp-a", "x.bin"), join(root, "fp-b", "link"));
      const dirs = await cacheDirSizes([root, join(root, "missing")]);
      expect(dirs.map((d) => d.path)).toEqual([
        join(root, "fp-a"),
        join(root, "fp-b"),
      ]);
      expect(dirs[0].bytes).toBeGreaterThanOrEqual(104_096);
      expect(dirs[0].bytes % 512).toBe(0);
      expect(dirs[1].bytes).toBe(0);
      expect(dirs[0].modelId).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing roots give an empty list", async () => {
    expect(await cacheDirSizes(["/nonexistent/mlx-spy"])).toEqual([]);
  });
});

describe("isLocalUrl", () => {
  const addrs = new Set(["100.100.1.2", "192.168.1.10", "fe80::1"]);
  const names = new Set(["studio", "studio.local"]);
  test("loopback always", () => {
    expect(isLocalUrl("http://127.0.0.1:11234", addrs, names)).toBe(true);
    expect(isLocalUrl("http://localhost:11234", addrs, names)).toBe(true);
    expect(isLocalUrl("http://[::1]:11234", addrs, names)).toBe(true);
  });
  test("own interface address or host name", () => {
    expect(isLocalUrl("http://100.100.1.2:11234", addrs, names)).toBe(true);
    expect(isLocalUrl("http://STUDIO.local:11234", addrs, names)).toBe(true);
    expect(isLocalUrl("http://[fe80::1]:11234", addrs, names)).toBe(true);
  });
  test("anything else is remote", () => {
    expect(isLocalUrl("http://100.100.9.9:11234", addrs, names)).toBe(false);
    expect(isLocalUrl("http://other.tailnet.ts.net:11234", addrs, names)).toBe(
      false,
    );
    expect(isLocalUrl("not a url", addrs, names)).toBe(false);
  });
});
