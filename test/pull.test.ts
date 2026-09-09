// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The downloader against a fake Hub: the model API body, the resolve URLs
// with Range support, a redirect hop, and faults on demand (a cut stream, a
// held stream, wrong bytes).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Capability,
  Engine,
  EngineMetrics,
  ModelInfo,
} from "../src/engine/types.ts";
import { History } from "../src/history.ts";
import { PullError, PullRunner } from "../src/pull.ts";
import { type Pull, PullStore } from "../src/pulls.ts";

const REPO = "org/model";
const REV = "0123456789abcdef";

type Fault = {
  // close the body after this many bytes, for the first `times` requests
  cutAfter?: number;
  times?: number;
  // send this many bytes, then wait for release() before the rest
  holdAfter?: number;
  // serve these bytes instead (a corrupt mirror)
  serve?: Uint8Array<ArrayBuffer>;
  // answer a range request with a 206 that starts at 0 anyway
  badRange?: boolean;
  // send this many bytes, then nothing, for the first `times` requests
  stallAfter?: number;
};

class FakeHub {
  server: ReturnType<typeof Bun.serve>;
  // a second origin the Hub can redirect to, like the real CDN
  cdn: ReturnType<typeof Bun.serve>;
  files = new Map<string, Uint8Array<ArrayBuffer>>();
  faults = new Map<string, Fault>();
  requests: {
    path: string;
    range: string | null;
    auth: string | null;
    origin: string;
  }[] = [];
  held: (() => void) | null = null;
  redirect: false | "same" | "cross" = false;
  status: number | null = null;
  listingDelayMs = 0;

  constructor() {
    this.server = Bun.serve({
      port: 0,
      fetch: (req) => this.handle(req),
    });
    this.cdn = Bun.serve({
      port: 0,
      fetch: (req) => this.handle(req),
    });
  }

  get url() {
    return `http://127.0.0.1:${this.server.port}`;
  }

  get cdnUrl() {
    return `http://127.0.0.1:${this.cdn.port}`;
  }

  stop() {
    this.server.stop(true);
    this.cdn.stop(true);
  }

  // waits for the held stream to reach its pause
  async holding() {
    const until = Date.now() + 5000;
    while (!this.held && Date.now() < until) await Bun.sleep(5);
    if (!this.held) throw new Error("nothing held");
  }

  // then lets it go
  async release() {
    await this.holding();
    this.held!();
    this.held = null;
  }

  private listing() {
    return {
      id: REPO,
      sha: REV,
      siblings: [...this.files].map(([path, bytes]) => ({
        rfilename: path,
        size: bytes.byteLength,
        ...(path.endsWith(".safetensors")
          ? { lfs: { sha256: sha256(bytes), size: bytes.byteLength } }
          : {}),
      })),
    };
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === `/api/models/${REPO}`) {
      if (this.listingDelayMs) await Bun.sleep(this.listingDelayMs);
      if (this.status) return new Response("no", { status: this.status });
      return Response.json(this.listing());
    }
    const m = new RegExp(`^/${REPO}/resolve/${REV}/(.+)$`).exec(url.pathname);
    if (m && this.redirect) {
      const base = this.redirect === "cross" ? this.cdnUrl : "";
      return new Response(null, {
        status: 307,
        headers: { location: `${base}/cdn/${m[1]}` },
      });
    }
    const cdn = /^\/cdn\/(.+)$/.exec(url.pathname);
    const path = decodeURIComponent((cdn ?? m)?.[1] ?? "");
    const bytes = this.files.get(path);
    if (!bytes) return new Response("not found", { status: 404 });
    const range = req.headers.get("range");
    this.requests.push({
      path,
      range,
      auth: req.headers.get("authorization"),
      origin: url.origin,
    });
    const fault = this.faults.get(path) ?? {};
    const body = fault.serve ?? bytes;
    let from = 0;
    if (range) {
      const r = /^bytes=(\d+)-$/.exec(range);
      if (!r) return new Response("bad range", { status: 416 });
      from = Number(r[1]);
      if (from >= body.byteLength) {
        return new Response("", { status: 416 });
      }
    }
    // a 206 that starts at 0 anyway: the client must not append it
    const partial = from > 0;
    if (fault.badRange && from > 0) from = 0;
    const slice = body.subarray(from);
    const faulty = (fault.times ?? 1) > 0;
    const cut = fault.cutAfter !== undefined && faulty ? fault.cutAfter : null;
    const stall =
      fault.stallAfter !== undefined && faulty ? fault.stallAfter : null;
    if (cut !== null || stall !== null) fault.times = (fault.times ?? 1) - 1;
    const hold = fault.holdAfter;
    const hub = this;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        if (cut !== null) {
          // a short body: the client sees the stream end early
          controller.enqueue(slice.subarray(0, cut));
          controller.close();
          return;
        }
        if (stall !== null) {
          // the body never ends and never sends more
          controller.enqueue(slice.subarray(0, stall));
          return;
        }
        if (hold !== undefined) {
          controller.enqueue(slice.subarray(0, hold));
          await new Promise<void>((resolve) => {
            hub.held = resolve;
          });
          controller.enqueue(slice.subarray(hold));
        } else {
          controller.enqueue(slice);
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: partial ? 206 : 200,
      headers: partial ? { "content-range": `bytes ${from}-` } : {},
    });
  }
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function bytesOf(n: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

class RescanEngine implements Engine {
  readonly id = "mlxserve" as const;
  readonly url = "http://fake";
  rescans = 0;
  async health() {
    return true;
  }
  async models(): Promise<ModelInfo[]> {
    return [];
  }
  async metrics(): Promise<EngineMetrics> {
    throw new Error("unused");
  }
  async load() {}
  async unload() {}
  async rescan() {
    this.rescans++;
  }
  capabilities(): Set<Capability> {
    return new Set(["rescan"]);
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
  async cacheLimits() {
    return null;
  }
}

let hub: FakeHub;
let dir: string;
let history: History;
let engine: RescanEngine;
let refreshed = 0;
let logs: string[];

beforeEach(async () => {
  hub = new FakeHub();
  hub.files.set("config.json", new TextEncoder().encode('{"a":1}'));
  hub.files.set("model.safetensors", bytesOf(50_000, 7));
  hub.files.set("sub/extra.safetensors", bytesOf(3_000, 9));
  dir = await mkdtemp(join(tmpdir(), "mlx-spy-pull-"));
  history = new History(":memory:");
  engine = new RescanEngine();
  refreshed = 0;
  logs = [];
});

afterEach(async () => {
  hub.stop();
  history.close();
  await rm(dir, { recursive: true, force: true });
});

function runner(
  overrides: Partial<ConstructorParameters<typeof PullRunner>[0]> = {},
) {
  const events: Pull[] = [];
  const r = new PullRunner({
    store: new PullStore(history.db),
    modelDir: dir,
    token: "hf_test",
    engine,
    refreshModels: async () => {
      refreshed++;
    },
    log: (line) => logs.push(line),
    hub: hub.url,
    retryDelayMs: 1,
    freeSpace: () => 10 * 1024 ** 3,
    ...overrides,
  });
  r.onEvent((pull) => events.push(structuredClone(pull)));
  return { r, events };
}

async function settled(r: PullRunner, id: number, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const pull = r.get(id)!;
    if (
      pull.status === "done" ||
      pull.status === "failed" ||
      pull.status === "cancelled"
    ) {
      return pull;
    }
    await Bun.sleep(5);
  }
  throw new Error("pull did not settle");
}

async function status(r: PullRunner, id: number, want: Pull["status"]) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (r.get(id)?.status === want) return r.get(id)!;
    await Bun.sleep(5);
  }
  throw new Error(`pull never became ${want}`);
}

async function fileBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await readFile(join(dir, "org", "model", path));
  return new Uint8Array(
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
}

describe("PullRunner", () => {
  test("downloads every file, verifies it and tells the engine", async () => {
    const { r, events } = runner();
    const pull = await r.start(`https://huggingface.co/${REPO}/tree/main`);
    expect(pull.status).toBe("queued");
    expect(pull.repo).toBe(REPO);
    expect(pull.revision).toBe(REV);
    expect(pull.filesTotal).toBe(3);
    expect(pull.bytesTotal).toBe(7 + 50_000 + 3_000);
    expect(pull.dir).toBe(join(dir, "org", "model"));
    const done = await settled(r, pull.id);
    expect(done.status).toBe("done");
    expect(done.bytesDone).toBe(done.bytesTotal);
    expect(done.filesDone).toBe(3);
    expect(done.file).toBeNull();
    expect(done.finishedAt).not.toBeNull();
    expect(await fileBytes("config.json")).toEqual(
      hub.files.get("config.json")!,
    );
    expect(await fileBytes("model.safetensors")).toEqual(
      hub.files.get("model.safetensors")!,
    );
    expect(await fileBytes("sub/extra.safetensors")).toEqual(
      hub.files.get("sub/extra.safetensors")!,
    );
    expect(await readdir(join(dir, "org", "model"))).not.toContain(
      "model.safetensors.mlx-spy-part",
    );
    expect(engine.rescans).toBe(1);
    expect(refreshed).toBe(1);
    expect(hub.requests.every((q) => q.auth === "Bearer hf_test")).toBe(true);
    expect(hub.requests.every((q) => q.range === null)).toBe(true);
    const kinds = events.map((e) => e.status);
    expect(kinds[0]).toBe("queued");
    expect(kinds).toContain("running");
    expect(kinds.at(-1)).toBe("done");
    expect(r.list()[0].id).toBe(pull.id);
    expect(logs.some((l) => l.includes("done"))).toBe(true);
  });

  test("resumes a cut file with a range request", async () => {
    hub.faults.set("model.safetensors", { cutAfter: 20_000, times: 2 });
    const { r, events } = runner();
    const pull = await r.start(REPO);
    const done = await settled(r, pull.id);
    expect(done.status).toBe("done");
    const weights = hub.requests.filter((q) => q.path === "model.safetensors");
    expect(weights.map((q) => q.range)).toEqual([
      null,
      "bytes=20000-",
      "bytes=40000-",
    ]);
    expect(await fileBytes("model.safetensors")).toEqual(
      hub.files.get("model.safetensors")!,
    );
    expect(logs.filter((l) => l.includes("retry")).length).toBe(2);
    // the resumed bytes are counted once
    expect(done.bytesDone).toBe(done.bytesTotal);
    expect(events.every((e) => e.bytesDone <= e.bytesTotal)).toBe(true);
  });

  test("follows a redirect; the bearer stays on the Hub's origin", async () => {
    hub.redirect = "same";
    const { r } = runner();
    const done = await settled(r, (await r.start(REPO)).id);
    expect(done.status).toBe("done");
    expect(hub.requests.length).toBe(3);
    expect(hub.requests.every((q) => q.auth === "Bearer hf_test")).toBe(true);

    await r.remove(done.id);
    await rm(dir, { recursive: true, force: true });
    hub.requests = [];
    hub.redirect = "cross";
    hub.faults.set("model.safetensors", { cutAfter: 20_000 });
    const again = await settled(r, (await r.start(REPO)).id);
    expect(again.status).toBe("done");
    // every file went to the other origin without the token, and the
    // resume's range went there too
    expect(hub.requests.length).toBe(4);
    expect(hub.requests.every((q) => q.origin === hub.cdnUrl)).toBe(true);
    expect(hub.requests.every((q) => q.auth === null)).toBe(true);
    expect(hub.requests.map((q) => q.range)).toContain("bytes=20000-");
  });

  test("gives up after the retries with the error", async () => {
    hub.faults.set("model.safetensors", { cutAfter: 10, times: 99 });
    const { r } = runner();
    const done = await settled(r, (await r.start(REPO)).id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("got 50 of 50000 bytes");
    // the part stays for a later retry
    expect(
      (await stat(join(dir, "org", "model", "model.safetensors.mlx-spy-part")))
        .size,
    ).toBe(50);
  });

  test("a wrong hash fails the pull and drops the part", async () => {
    hub.faults.set("model.safetensors", { serve: bytesOf(50_000, 8) });
    const { r } = runner();
    const done = await settled(r, (await r.start(REPO)).id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("model.safetensors: sha256 mismatch");
    await expect(
      stat(join(dir, "org", "model", "model.safetensors.mlx-spy-part")),
    ).rejects.toThrow();
    expect(engine.rescans).toBe(0);
  });

  test("cancel keeps the part and a new start resumes it", async () => {
    hub.faults.set("model.safetensors", { holdAfter: 30_000 });
    const { r, events } = runner();
    const pull = await r.start(REPO);
    await status(r, pull.id, "running");
    // wait for the held bytes to land
    const until = Date.now() + 5000;
    while (Date.now() < until && (r.get(pull.id)?.bytesDone ?? 0) < 30_007) {
      await Bun.sleep(5);
    }
    expect(r.running()?.file).toBe("model.safetensors");
    // the answer waits for the abort to unwind: it carries the final state
    const cancelling = r.cancel(pull.id);
    await hub.release();
    const cancelled = await cancelling;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.bytesDone).toBe(30_007);
    expect(events.at(-1)?.status).toBe("cancelled");
    hub.faults.delete("model.safetensors");
    const again = await r.start(REPO);
    expect(again.id).toBe(pull.id);
    const done = await settled(r, pull.id);
    expect(done.status).toBe("done");
    const weights = hub.requests.filter((q) => q.path === "model.safetensors");
    expect(weights.map((q) => q.range)).toEqual([null, "bytes=30000-"]);
    expect(await fileBytes("model.safetensors")).toEqual(
      hub.files.get("model.safetensors")!,
    );
  });

  test("a restart resumes the pull that was running", async () => {
    hub.faults.set("model.safetensors", { holdAfter: 10_000 });
    const first = runner();
    const pull = await first.r.start(REPO);
    await status(first.r, pull.id, "running");
    const until = Date.now() + 5000;
    while (
      Date.now() < until &&
      (first.r.get(pull.id)?.bytesDone ?? 0) < 10_007
    ) {
      await Bun.sleep(5);
    }
    first.r.shutdown();
    await hub.release();
    await Bun.sleep(20);
    // the database still says running: the next process picks it up
    expect(new PullStore(history.db).get(pull.id)?.status).toBe("running");
    hub.faults.delete("model.safetensors");
    const second = runner();
    second.r.resume();
    const done = await settled(second.r, pull.id);
    expect(done.status).toBe("done");
    expect(logs.some((l) => l.includes("resuming"))).toBe(true);
    const weights = hub.requests.filter((q) => q.path === "model.safetensors");
    expect(weights.map((q) => q.range)).toEqual([null, "bytes=10000-"]);
    expect(await fileBytes("model.safetensors")).toEqual(
      hub.files.get("model.safetensors")!,
    );
  });

  test("a second start of the same repo is refused while it runs", async () => {
    hub.faults.set("model.safetensors", { holdAfter: 10 });
    const { r } = runner();
    const pull = await r.start(REPO);
    await expect(r.start(REPO)).rejects.toMatchObject({ status: 409 });
    await hub.release();
    await settled(r, pull.id);
  });

  test("refuses bad ids, unknown repos and a full disk", async () => {
    const { r } = runner({ freeSpace: () => 1000 });
    await expect(r.start("nope")).rejects.toMatchObject({
      status: 400,
      message: "repo must be <owner>/<name> or a Hub URL",
    });
    hub.status = 404;
    await expect(r.start("org/other")).rejects.toMatchObject({ status: 404 });
    hub.status = null;
    const done = await settled(r, (await r.start(REPO)).id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("not enough disk");
  });

  test("remove deletes the files of any pull, a running one included", async () => {
    hub.faults.set("model.safetensors", { cutAfter: 10, times: 99 });
    const { r } = runner();
    const failed = await settled(r, (await r.start(REPO)).id);
    expect(failed.status).toBe("failed");
    await r.remove(failed.id);
    expect(r.get(failed.id)).toBeNull();
    await expect(stat(join(dir, "org"))).rejects.toThrow();

    hub.faults.delete("model.safetensors");
    const done = await settled(r, (await r.start(REPO)).id);
    expect(done.status).toBe("done");
    await r.remove(done.id);
    expect(r.list()).toEqual([]);
    await expect(stat(join(dir, "org"))).rejects.toThrow();

    // mid-download: stopped, then gone
    hub.faults.set("model.safetensors", { holdAfter: 10_000 });
    const running = await r.start(REPO);
    await hub.holding();
    const removing = r.remove(running.id);
    await hub.release();
    await removing;
    expect(r.list()).toEqual([]);
    await expect(stat(join(dir, "org"))).rejects.toThrow();

    await expect(r.remove(999)).rejects.toBeInstanceOf(PullError);
    await expect(r.cancel(999)).rejects.toBeInstanceOf(PullError);
  });

  test("files already whole on disk are not fetched again", async () => {
    const { r } = runner();
    const done = await settled(r, (await r.start(REPO)).id);
    expect(done.status).toBe("done");
    hub.requests = [];
    // a finished pull is not resumed: a new one verifies what is there
    const again = await settled(r, (await r.start(REPO)).id);
    expect(again.id).not.toBe(done.id);
    expect(again.status).toBe("done");
    expect(again.filesDone).toBe(3);
    expect(hub.requests).toEqual([]);
  });

  test("a file on disk with the wrong bytes or missing goes again", async () => {
    const { r } = runner();
    const done = await settled(r, (await r.start(REPO)).id);
    expect(done.status).toBe("done");
    // same size, other bytes: the hash tells; and one file gone
    await Bun.write(
      join(dir, "org", "model", "model.safetensors"),
      bytesOf(50_000, 8),
    );
    await rm(join(dir, "org", "model", "config.json"));
    hub.requests = [];
    const again = await settled(r, (await r.start(REPO)).id);
    expect(again.status).toBe("done");
    expect(hub.requests.map((q) => q.path).sort()).toEqual([
      "config.json",
      "model.safetensors",
    ]);
    expect(await fileBytes("model.safetensors")).toEqual(
      hub.files.get("model.safetensors")!,
    );
  });

  test("a done file that vanished before a resume goes again", async () => {
    hub.faults.set("model.safetensors", { holdAfter: 10_000 });
    const { r } = runner();
    const pull = await r.start(REPO);
    await hub.holding();
    const cancelling = r.cancel(pull.id);
    await hub.release();
    await cancelling;
    await rm(join(dir, "org", "model", "config.json"));
    hub.faults.delete("model.safetensors");
    hub.requests = [];
    const done = await settled(r, (await r.start(REPO)).id);
    expect(done.status).toBe("done");
    expect(done.filesDone).toBe(3);
    expect(done.bytesDone).toBe(done.bytesTotal);
    expect(hub.requests.map((q) => q.path)).toContain("config.json");
    expect(await fileBytes("config.json")).toEqual(
      hub.files.get("config.json")!,
    );
  });

  test("a second start while the listing is fetched is refused", async () => {
    hub.listingDelayMs = 100;
    const { r } = runner();
    const first = r.start(REPO);
    await Bun.sleep(10);
    await expect(r.start(REPO)).rejects.toMatchObject({ status: 409 });
    const pull = await first;
    expect((await settled(r, pull.id)).status).toBe("done");
    expect(r.list().length).toBe(1);
  });

  test("a 206 from the wrong offset is retried, not appended", async () => {
    hub.faults.set("model.safetensors", {
      cutAfter: 20_000,
      times: 1,
      badRange: true,
    });
    const { r } = runner();
    const done = await settled(r, (await r.start(REPO)).id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("unexpected range: bytes 0-");
    await expect(
      stat(join(dir, "org", "model", "model.safetensors")),
    ).rejects.toThrow();
  });

  test("a stalled body is dropped and resumed", async () => {
    hub.faults.set("model.safetensors", { stallAfter: 20_000, times: 1 });
    const { r } = runner({ stallMs: 50 });
    const done = await settled(r, (await r.start(REPO)).id);
    expect(done.status).toBe("done");
    const weights = hub.requests.filter((q) => q.path === "model.safetensors");
    expect(weights.map((q) => q.range)).toEqual([null, "bytes=20000-"]);
    expect(logs.some((l) => l.includes("no data for"))).toBe(true);
    expect(await fileBytes("model.safetensors")).toEqual(
      hub.files.get("model.safetensors")!,
    );
  });

  test("a zero-byte file and a file named like a part", async () => {
    hub.files.set("empty.txt", new Uint8Array(0));
    hub.files.set("model.safetensors.mlx-spy-part", bytesOf(10));
    const { r } = runner();
    const pull = await r.start(REPO);
    expect(pull.filesTotal).toBe(4);
    const done = await settled(r, pull.id);
    expect(done.status).toBe("done");
    expect((await stat(join(dir, "org", "model", "empty.txt"))).size).toBe(0);
    expect(hub.requests.map((q) => q.path)).not.toContain("empty.txt");
  });

  test("shutdown after a cancel keeps the cancel", async () => {
    hub.faults.set("model.safetensors", { holdAfter: 10_000 });
    const { r } = runner();
    const pull = await r.start(REPO);
    await hub.holding();
    const cancelling = r.cancel(pull.id);
    r.shutdown();
    await hub.release();
    expect((await cancelling).status).toBe("cancelled");
  });
});
