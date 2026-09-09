// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The model downloader: pulls a Hugging Face repo into the model directory,
// one pull at a time, from a queue that survives restarts through the
// PullStore. Every file streams into <file>.part and resumes with a Range
// request after a cut, a retry or a restart; the hash is computed while
// writing (the existing part first, on a resume) and checked against the
// Hub's LFS sha256 before the rename. Progress reaches every tab on /ws.
//
// The engine is not involved in the download. After a pull the runner asks
// it to rescan its model directory (mlx-serve answers /v1/models/rescan
// before its model-load step, like /v1/models; verified in src/server.zig)
// so the new checkpoint shows in the list without an engine restart.

import {
  mkdir,
  open,
  rename,
  rm,
  rmdir,
  stat,
  truncate,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Engine } from "./engine/types.ts";
import { diskSpace } from "./host/info.ts";
import {
  fetchRepo,
  HubError,
  hubHeaders,
  PART_SUFFIX,
  parseRepoId,
  resolveUrl,
} from "./hub.ts";
import type { Pull, PullFile, PullStore } from "./pulls.ts";

const RETRIES = 5;
const RETRY_DELAY_MS = 2000;
const PROGRESS_EVERY_MS = 500;
const WRITE_EVERY_MS = 1000;
const SPEED_WINDOW_MS = 5000;
const MAX_REDIRECTS = 5;
const DISK_MARGIN = 1024 ** 3;
const HASH_CHUNK = 4 * 1024 * 1024;
// a body that sends nothing for this long is dropped and retried
const STALL_MS = 60_000;

export class PullError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// a failure worth another attempt at the same file (the .part is kept)
class Retryable extends Error {}

export type PullRunnerDeps = {
  store: PullStore;
  modelDir: string;
  token: string | null;
  engine: Engine;
  refreshModels: () => Promise<unknown>;
  log: (line: string) => void;
  now?: () => number;
  // tests: a fake Hub, no wait between retries
  hub?: string;
  retryDelayMs?: number;
  stallMs?: number;
  freeSpace?: (path: string) => number | null;
};

type Active = {
  id: number;
  controller: AbortController;
  // resolves when run() has written the final status
  settled: Promise<void>;
  settle: () => void;
  // the user asked for the stop (a shutdown is not a cancel)
  cancelled: boolean;
  bytesDone: number;
  file: string | null;
  window: { t: number; bytes: number }[];
  publishedAt: number;
  writtenAt: number;
};

export class PullRunner {
  private active: Active | null = null;
  private readonly queue: number[] = [];
  private stopping = false;
  // repos whose listing is being fetched: a second start of one is a 409
  private readonly starting = new Set<string>();
  private readonly listeners = new Set<(pull: Pull) => void>();
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly stallMs: number;
  private readonly freeSpace: (path: string) => number | null;

  constructor(private readonly deps: PullRunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
    this.stallMs = deps.stallMs ?? STALL_MS;
    this.freeSpace = deps.freeSpace ?? ((p) => diskSpace(p)?.free ?? null);
  }

  onEvent(fn: (pull: Pull) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // The pulls, newest first, the running one with its speed.
  list(): Pull[] {
    return this.deps.store.list().map((pull) => this.stamp(pull));
  }

  get(id: number): Pull | null {
    const pull = this.deps.store.get(id);
    return pull ? this.stamp(pull) : null;
  }

  running(): Pull | null {
    return this.active ? this.get(this.active.id) : null;
  }

  // Pulls left queued or running by the previous process continue.
  resume() {
    for (const pull of this.deps.store.unfinished()) {
      this.deps.store.setStatus(pull.id, "queued");
      this.queue.push(pull.id);
      this.deps.log(`pull ${pull.repo}: resuming`);
    }
    this.kick();
  }

  // A repo id or Hub URL → the queued pull. The same repo again resumes
  // its failed or cancelled pull; one still queued or running is a 409.
  async start(input: string): Promise<Pull> {
    const repo = parseRepoId(input);
    if (!repo) {
      throw new PullError(400, "repo must be <owner>/<name> or a Hub URL");
    }
    const open = this.deps.store.findOpen(repo);
    if (
      this.starting.has(repo) ||
      open?.status === "queued" ||
      open?.status === "running"
    ) {
      throw new PullError(409, `${repo} is already downloading`);
    }
    if (open) {
      const pull = this.deps.store.setStatus(open.id, "queued")!;
      this.queue.push(pull.id);
      this.publish(pull);
      this.kick();
      return pull;
    }
    let listing: Awaited<ReturnType<typeof fetchRepo>>;
    this.starting.add(repo);
    try {
      listing = await fetchRepo(
        repo,
        this.deps.token,
        undefined,
        this.deps.hub,
      );
    } catch (err) {
      if (err instanceof HubError) throw new PullError(err.status, err.message);
      throw new PullError(502, describe(err));
    } finally {
      this.starting.delete(repo);
    }
    const dir = join(this.deps.modelDir, ...repo.split("/"));
    const pull = this.deps.store.create(
      repo,
      listing.revision,
      dir,
      listing.files,
    );
    this.deps.log(
      `pull ${repo}: queued, ${listing.files.length} files, ${Math.round(pull.bytesTotal / 1024 ** 2)} MB`,
    );
    this.queue.push(pull.id);
    this.publish(pull);
    this.kick();
    return pull;
  }

  // Stops the pull; its parts stay for a later resume. Answers once the
  // row says so, after the abort has unwound the download.
  async cancel(id: number): Promise<Pull> {
    const pull = this.deps.store.get(id);
    if (!pull) throw new PullError(404, "Pull not found");
    const active = this.active;
    if (active?.id === id) {
      active.cancelled = true;
      active.controller.abort();
      await active.settled;
      return this.deps.store.get(id)!;
    }
    const at = this.queue.indexOf(id);
    if (at !== -1) {
      this.queue.splice(at, 1);
      const cancelled = this.deps.store.setStatus(id, "cancelled")!;
      this.publish(cancelled);
      return cancelled;
    }
    throw new PullError(409, `${pull.repo} is not downloading`);
  }

  // Deletes the pull: a running one is stopped first, then its files go,
  // finished or partial, and the record with them.
  async remove(id: number): Promise<void> {
    const pull = this.deps.store.get(id);
    if (!pull) throw new PullError(404, "Pull not found");
    if (pull.status === "queued" || pull.status === "running") {
      await this.cancel(id);
    }
    const parents = new Set<string>();
    for (const file of this.deps.store.files(id)) {
      const dest = destOf(pull.dir, file.path);
      if (!dest) continue;
      await rm(dest + PART_SUFFIX, { force: true });
      await rm(dest, { force: true });
      parents.add(dirname(dest));
    }
    // the repo's own subdirectories, deepest first, then up to the root
    for (const parent of [...parents].sort((a, b) => b.length - a.length)) {
      await pruneEmpty(parent, this.deps.modelDir);
    }
    await pruneEmpty(pull.dir, this.deps.modelDir);
    this.deps.store.remove(id);
    this.deps.log(`pull ${pull.repo}: deleted`);
  }

  // The process is leaving: the running pull keeps its status so the next
  // process resumes it.
  shutdown() {
    this.stopping = true;
    this.active?.controller.abort();
  }

  private kick() {
    if (this.active || this.stopping) return;
    const id = this.queue.shift();
    if (id === undefined) return;
    void this.run(id);
  }

  private async run(id: number) {
    const pull = this.deps.store.setStatus(id, "running");
    if (!pull) return this.kick();
    let settle = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const active: Active = {
      id,
      controller: new AbortController(),
      settled,
      settle,
      cancelled: false,
      bytesDone: pull.bytesDone,
      file: null,
      window: [],
      publishedAt: 0,
      writtenAt: 0,
    };
    this.active = active;
    this.publish(pull);
    try {
      await this.download(pull, active);
      this.deps.store.progress(id, active.bytesDone, null);
      const done = this.deps.store.setStatus(id, "done")!;
      this.deps.log(`pull ${pull.repo}: done`);
      this.active = null;
      this.publish(done);
      await this.announce(pull.repo);
    } catch (err) {
      this.deps.store.progress(id, active.bytesDone, null);
      if (this.stopping && !active.cancelled) {
        // left "running": the next process resumes it
      } else if (active.controller.signal.aborted) {
        this.publish(this.deps.store.setStatus(id, "cancelled")!);
        this.deps.log(`pull ${pull.repo}: cancelled`);
      } else {
        const message = describe(err);
        this.publish(this.deps.store.setStatus(id, "failed", message)!);
        this.deps.log(`pull ${pull.repo}: failed: ${message}`);
      }
    } finally {
      this.active = null;
      active.settle();
      this.kick();
    }
  }

  private async download(pull: Pull, active: Active) {
    const files = this.deps.store.files(pull.id);
    // what is left: finished files count, and so do files already whole on
    // disk (a pull of a model that was there before)
    let bytesDone = 0;
    const todo: PullFile[] = [];
    const signal = active.controller.signal;
    for (const file of files) {
      const dest = destOf(pull.dir, file.path);
      if (!dest) throw new Error(`refusing path ${file.path}`);
      const onDisk = (await sizeOf(dest)) === file.size;
      // a file the record calls done must still be there whole; a file
      // that is there but not on record (a model that was there before,
      // an earlier removed pull) must also match the Hub's hash
      if (
        onDisk &&
        (file.done ||
          !file.sha256 ||
          (await hashOf(dest, signal)) === file.sha256)
      ) {
        if (!file.done) this.deps.store.fileDone(pull.id, file.path);
        bytesDone += file.size;
        continue;
      }
      if (file.done) this.deps.store.fileUndone(pull.id, file.path);
      todo.push(file);
    }
    active.bytesDone = bytesDone;
    // statfs needs the directory to exist
    await mkdir(this.deps.modelDir, { recursive: true });
    const free = this.freeSpace(this.deps.modelDir);
    const left = pull.bytesTotal - bytesDone;
    if (free !== null && free < left + DISK_MARGIN) {
      throw new Error(
        `not enough disk: ${Math.round(free / 1024 ** 3)} GB free, ${Math.ceil(left / 1024 ** 3)} GB to download`,
      );
    }
    for (const file of todo) {
      const dest = destOf(pull.dir, file.path)!;
      await mkdir(dirname(dest), { recursive: true });
      active.file = file.path;
      const url = resolveUrl(
        pull.repo,
        pull.revision,
        file.path,
        this.deps.hub,
      );
      await this.fetchFile(url, file, dest, active);
      this.deps.store.fileDone(pull.id, file.path);
      active.file = null;
      this.tick(pull.id, active, true);
    }
  }

  private async fetchFile(
    url: string,
    file: PullFile,
    dest: string,
    active: Active,
  ) {
    const signal = active.controller.signal;
    // the finished files so far; the part in flight is added on top
    const base = active.bytesDone;
    if (file.size === 0) {
      await Bun.write(dest, "");
      return;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await this.stream(url, file, dest, active, base);
        return;
      } catch (err) {
        if (signal.aborted) throw err;
        if (!(err instanceof Retryable) || attempt >= RETRIES) throw err;
        this.deps.log(
          `pull ${file.path}: ${describe(err)}; retry ${attempt} of ${RETRIES - 1}`,
        );
        await sleep(this.retryDelayMs * attempt, signal);
      }
    }
  }

  // One attempt at a file: resume the .part, verify, rename.
  private async stream(
    url: string,
    file: PullFile,
    dest: string,
    active: Active,
    base: number,
  ) {
    const signal = active.controller.signal;
    const part = dest + PART_SUFFIX;
    let have = (await sizeOf(part)) ?? 0;
    let hasher = file.sha256 ? new Bun.CryptoHasher("sha256") : null;
    // a part longer than the file is not this file: start over
    if (have > file.size) {
      await truncate(part, 0);
      have = 0;
    }
    if (have > 0 && hasher) await hashFile(part, hasher, signal);
    active.bytesDone = base + have;
    if (have < file.size) {
      const res = await this.request(url, have, signal);
      // a 206 must continue where the part ends; a 200 to a range request
      // means the server ignored it and what we have is worthless
      const contentRange = res.headers.get("content-range") ?? "";
      if (
        have > 0 &&
        (res.status === 200 ||
          (res.status === 206 && !contentRange.startsWith(`bytes ${have}-`)))
      ) {
        if (res.status === 206) {
          await res.body?.cancel();
          throw new Retryable(`unexpected range: ${contentRange || "none"}`);
        }
        await truncate(part, 0);
        have = 0;
        active.bytesDone = base;
        if (hasher) hasher = new Bun.CryptoHasher("sha256");
      } else if (res.status !== 200 && res.status !== 206) {
        await res.body?.cancel();
        throw statusError(res.status);
      }
      if (!res.body) throw new Retryable("empty body");
      const handle = await open(part, "a");
      // a body that stalls is dropped, and the retry resumes the part
      const stall = new AbortController();
      let timer = setTimeout(() => stall.abort(), this.stallMs);
      const onAbort = () => stall.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const reader = res.body.getReader();
        while (true) {
          const next = await Promise.race([
            reader.read(),
            aborted(stall.signal),
          ]);
          if (next.done) break;
          const chunk = next.value;
          clearTimeout(timer);
          timer = setTimeout(() => stall.abort(), this.stallMs);
          if (have + chunk.byteLength > file.size) {
            // more than the file: not this file
            await reader.cancel().catch(() => {});
            await handle.close();
            await truncate(part, 0);
            throw new Retryable(`got more than ${file.size} bytes`);
          }
          await handle.write(chunk);
          hasher?.update(chunk);
          have += chunk.byteLength;
          active.bytesDone = base + have;
          this.tick(active.id, active, false);
        }
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        if (stall.signal.aborted) {
          await res.body.cancel().catch(() => {});
          throw new Retryable(
            `no data for ${Math.round(this.stallMs / 1000)} s`,
          );
        }
        throw err instanceof Retryable ? err : new Retryable(describe(err));
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        await handle.close().catch(() => {});
      }
    }
    if (have !== file.size) {
      throw new Retryable(`got ${have} of ${file.size} bytes`);
    }
    if (hasher && file.sha256) {
      const digest = hasher.digest("hex");
      if (digest !== file.sha256) {
        // the bytes are wrong, not missing: no resume, the file starts over
        await rm(part, { force: true });
        throw new Error(`${file.path}: sha256 mismatch`);
      }
    }
    await rename(part, dest);
  }

  // Redirects are followed by hand: the Hub answers with a 307 to a signed
  // CDN URL, and the bearer must not travel to another host.
  private async request(
    url: string,
    from: number,
    signal: AbortSignal,
  ): Promise<Response> {
    let current = url;
    let authorized = true;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers = hubHeaders(authorized ? this.deps.token : null);
      if (from > 0) headers.range = `bytes=${from}-`;
      let res: Response;
      try {
        res = await fetch(current, { headers, signal, redirect: "manual" });
      } catch (err) {
        if (signal.aborted) throw err;
        throw new Retryable(describe(err));
      }
      if (res.status < 300 || res.status >= 400) return res;
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) throw new Retryable(`redirect without location`);
      const next = new URL(location, current);
      // another origin (a CDN host, or plain http) never sees the bearer
      authorized = authorized && next.origin === new URL(current).origin;
      current = next.toString();
    }
    throw new Retryable("too many redirects");
  }

  // Progress to the tabs twice a second and to the database once a second;
  // a change of state goes out at once.
  private tick(id: number, active: Active, force: boolean) {
    const t = this.now();
    active.window.push({ t, bytes: active.bytesDone });
    while (
      active.window.length > 1 &&
      t - active.window[0].t > SPEED_WINDOW_MS
    ) {
      active.window.shift();
    }
    if (force || t - active.writtenAt >= WRITE_EVERY_MS) {
      active.writtenAt = t;
      this.deps.store.progress(id, active.bytesDone, active.file);
    }
    if (force || t - active.publishedAt >= PROGRESS_EVERY_MS) {
      active.publishedAt = t;
      const pull = this.deps.store.get(id);
      if (pull) this.publish(this.stamp(pull));
    }
  }

  private stamp(pull: Pull): Pull {
    const active = this.active;
    if (!active || active.id !== pull.id || pull.status !== "running") {
      return pull;
    }
    const first = active.window[0];
    const last = active.window.at(-1);
    const speed =
      first && last && last.t > first.t
        ? ((last.bytes - first.bytes) * 1000) / (last.t - first.t)
        : null;
    return {
      ...pull,
      bytesDone: active.bytesDone,
      file: active.file,
      speedBps: speed,
    };
  }

  private async announce(repo: string) {
    try {
      if (this.deps.engine.capabilities().has("rescan")) {
        await this.deps.engine.rescan?.();
      }
      await this.deps.refreshModels();
    } catch (err) {
      this.deps.log(`pull ${repo}: engine rescan failed: ${describe(err)}`);
    }
  }

  private publish(pull: Pull) {
    for (const listener of this.listeners) {
      try {
        listener(pull);
      } catch (err) {
        this.deps.log(`pull listener failed: ${describe(err)}`);
      }
    }
  }
}

// ---------- helpers ----------

// The file's place under the pull's directory, or null when the stored
// path would leave it.
export function destOf(dir: string, path: string): string | null {
  const dest = resolve(dir, path);
  const root = resolve(dir);
  return dest.startsWith(root + sep) ? dest : null;
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

async function hashOf(path: string, signal: AbortSignal): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  await hashFile(path, hasher, signal);
  return hasher.digest("hex");
}

// rejects when the signal fires; races a read that may never resolve
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
  });
}

async function hashFile(
  path: string,
  hasher: Bun.CryptoHasher,
  signal: AbortSignal,
) {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(HASH_CHUNK);
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { bytesRead } = await handle.read(buffer, 0, HASH_CHUNK, null);
      if (bytesRead === 0) break;
      hasher.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

// Removes the model directory and its owner directory when empty, up to
// the model root, so a removed partial pull leaves nothing behind.
async function pruneEmpty(dir: string, root: string) {
  let current = resolve(dir);
  const top = resolve(root);
  while (current.startsWith(top + sep)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function statusError(status: number): Error {
  if (status === 401 || status === 403) {
    return new PullError(403, "gated or private repo; add hf.key");
  }
  if (status === 404) return new PullError(404, "file not found on the Hub");
  if (status === 416) return new Retryable("range refused");
  return new Retryable(`HTTP ${status}`);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
