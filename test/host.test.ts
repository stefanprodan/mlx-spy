import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDarwinProbes } from "../src/host/darwin.ts";
import { cacheDirSizes } from "../src/host/disk.ts";
import { isLocalUrl } from "../src/host/local.ts";

const onDarwin = process.platform === "darwin";

describe.if(onDarwin)("darwin probes", () => {
  const p = createDarwinProbes();

  test("host memory adds up to something sane", () => {
    const m = p.hostMemory();
    expect(m).not.toBeNull();
    // 8 GB is the smallest Apple Silicon Mac
    expect(m!.total).toBeGreaterThanOrEqual(8 * 1024 ** 3);
    expect(m!.free + m!.active + m!.inactive + m!.wired).toBeGreaterThan(0);
    expect(m!.free + m!.active + m!.inactive + m!.wired).toBeLessThan(m!.total);
    expect(m!.free % 16384).toBe(0); // whole pages
  });

  test("process memory of this process", () => {
    const pm = p.processMemory(process.pid);
    expect(pm).not.toBeNull();
    expect(pm!.footprint).toBeGreaterThan(1024 * 1024);
    expect(pm!.rss).toBeGreaterThan(1024 * 1024);
    // started within the last day and not in the future
    expect(pm!.startedAt).toBeGreaterThan(Date.now() - 86_400_000);
    expect(pm!.startedAt).toBeLessThanOrEqual(Date.now() + 1000);
    // this test process has burned some CPU, but not more than its lifetime
    expect(pm!.cpuNs).toBeGreaterThan(0);
    expect(pm!.cpuNs).toBeLessThan((Date.now() - pm!.startedAt) * 1e6 * 32);
  });

  test("process memory of a dead pid is null", () => {
    expect(p.processMemory(2 ** 30)).toBeNull();
  });

  test("findPid by executable name finds this bun", () => {
    const pid = p.findPid(["bun"]);
    expect(pid).not.toBeNull();
    expect(p.pidMatches(pid!, ["bun"])).toBe(true);
    expect(p.pidMatches(pid!, ["mlx-serve"])).toBe(false);
    expect(p.findPid(["no-such-binary-xyz"])).toBeNull();
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
      // allocated blocks round up to the filesystem block size
      expect(dirs[0].bytes).toBeGreaterThanOrEqual(104_096);
      expect(dirs[0].bytes).toBeLessThan(104_096 + 2 * 16384);
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
