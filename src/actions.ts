// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The control actions: load, unload and set-default go through the engine
// adapter; free (a launchd restart of the service) and disk clear (delete the
// SSD cache tier contents) are the program's only spawns and file deletions,
// and both run only when the engine is on this host; history clear wipes
// mlx-spy's own sample database and touches no engine, as does favorite
// (the daily-driver mark on one model). Every action is an
// explicit user request from the UI, is checked against the engine's
// capabilities and the current model list, runs one at a time, and is logged
// with its outcome. The sampler never calls into here.

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Engine } from "./engine/types.ts";
import type { History } from "./history.ts";
import type { Sampler } from "./sampler.ts";

export const ACTION_NAMES = [
  "load",
  "unload",
  "default",
  "free",
  "diskClear",
  "historyClear",
  "favorite",
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export function isActionName(v: string): v is ActionName {
  return (ACTION_NAMES as readonly string[]).includes(v);
}

// one row of the action log, also pushed to the dashboard
export type ActionEvent = {
  t: number;
  action: ActionName;
  model: string | null;
  ok: boolean;
  ms: number;
  detail: string;
};

// carries the HTTP status the route should answer with
export class ActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type SpawnResult = { code: number; stderr: string };

export type ActionDeps = {
  engine: Engine;
  sampler: Sampler;
  history: History;
  local: boolean;
  log: (line: string) => void;
  // launchd domain owner; the service runs in the user's gui domain
  uid?: number;
  now?: () => number;
  // injectable for tests: the process spawn and the directory wipe
  spawn?: (cmd: string[]) => Promise<SpawnResult>;
  clearDir?: (root: string) => Promise<number>;
};

const EVENTS_KEPT = 50;

async function bunSpawn(cmd: string[]): Promise<SpawnResult> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return { code, stderr: stderr.trim() };
}

// Deletes the children of `root`, never `root` itself: the engine recreates
// per-model directories under it on the next load. A missing root is fine.
export async function clearDirContents(root: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (err: any) {
    if (err?.code === "ENOENT") return 0;
    throw err;
  }
  for (const name of names) {
    await rm(join(root, name), { recursive: true, force: true });
  }
  return names.length;
}

export class Actions {
  readonly events: ActionEvent[] = [];
  private busy: ActionName | null = null;
  private readonly listeners = new Set<(e: ActionEvent) => void>();
  private readonly now: () => number;
  private readonly spawn: (cmd: string[]) => Promise<SpawnResult>;
  private readonly clearDir: (root: string) => Promise<number>;
  private readonly uid: number;

  constructor(private readonly deps: ActionDeps) {
    this.now = deps.now ?? Date.now;
    this.spawn = deps.spawn ?? bunSpawn;
    this.clearDir = deps.clearDir ?? clearDirContents;
    this.uid = deps.uid ?? process.getuid?.() ?? 501;
  }

  onEvent(fn: (e: ActionEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  running(): ActionName | null {
    return this.busy;
  }

  // Validates, runs, logs. Throws ActionError with the status to answer.
  async run(name: string, body: unknown): Promise<ActionEvent> {
    if (!isActionName(name)) {
      throw new ActionError(404, `unknown action: ${name}`);
    }
    const capability = name === "free" ? "restart" : name;
    if (
      capability !== "historyClear" &&
      capability !== "favorite" &&
      !this.deps.engine.capabilities().has(capability)
    ) {
      throw new ActionError(403, `${this.deps.engine.id} cannot ${name}`);
    }
    if ((name === "free" || name === "diskClear") && !this.deps.local) {
      throw new ActionError(
        403,
        `${name} only works when the engine runs on this host`,
      );
    }
    const model = this.modelFor(name, body);
    if (this.busy) {
      throw new ActionError(409, `${this.busy} is still running`);
    }
    this.busy = name;
    const started = this.now();
    let ok = true;
    let detail = "";
    // a refusal keeps its own status; an adapter, spawn or file failure is 502
    let status = 502;
    try {
      try {
        detail = await this.perform(name, model);
      } catch (err) {
        ok = false;
        detail = err instanceof Error ? err.message : String(err);
        if (err instanceof ActionError) status = err.status;
      }
      // the table must reflect the new residency without waiting 5 s; the
      // action stays busy until every tab has the event so a second one
      // cannot start on a stale picture
      await this.deps.sampler.refreshModels();
      const event: ActionEvent = {
        t: this.now(),
        action: name,
        model,
        ok,
        ms: this.now() - started,
        detail,
      };
      this.events.push(event);
      if (this.events.length > EVENTS_KEPT) this.events.shift();
      this.deps.log(
        `action ${name}${model ? ` ${model}` : ""}: ${ok ? "ok" : "failed"} in ${event.ms} ms${detail ? ` (${detail})` : ""}`,
      );
      for (const fn of this.listeners) fn(event);
      if (!ok) throw new ActionError(status, detail);
      return event;
    } finally {
      this.busy = null;
    }
  }

  // The model id comes from the request but must name a model the engine
  // listed; the actions never forward arbitrary strings to the engine.
  private modelFor(name: ActionName, body: unknown): string | null {
    if (name === "free" || name === "diskClear" || name === "historyClear") {
      return null;
    }
    const id = (body as any)?.model;
    if (typeof id !== "string" || id === "") {
      throw new ActionError(400, `${name} needs a model id`);
    }
    const known = this.deps.sampler.currentModels().find((m) => m.id === id);
    if (!known) throw new ActionError(400, `unknown model: ${id}`);
    if (name === "unload" && !known.loaded) {
      throw new ActionError(400, `${id} is not loaded`);
    }
    return id;
  }

  private async perform(name: ActionName, model: string | null) {
    switch (name) {
      // A load makes the model the engine's default, and an unload hands the
      // default to the model still resident (the favorite first): a request
      // without a model then goes to what is in memory instead of cold
      // loading something else.
      case "load": {
        const asDefault = this.deps.engine.capabilities().has("default");
        await this.deps.engine.load(model!, asDefault);
        return asDefault ? "loaded as default" : "loaded";
      }
      case "unload": {
        await this.deps.engine.unload(model!);
        if (!this.deps.engine.capabilities().has("default")) return "unloaded";
        const rest = (await this.deps.sampler.refreshModels()).filter(
          (m) => m.loaded && m.id !== model,
        );
        const next = rest.find((m) => m.favorite) ?? rest[0];
        if (!next) return "unloaded";
        await this.deps.engine.load(next.id, true);
        return `unloaded; ${next.id} is the default`;
      }
      case "default":
        await this.deps.engine.load(model!, true);
        return "loaded as default";
      case "favorite": {
        const fav = this.deps.history.toggleFavorite(model!);
        this.deps.sampler.stampFavorite();
        return fav === model ? "daily driver" : "no daily driver";
      }
      case "free":
        return this.restart();
      case "diskClear": {
        // as mlxctl does: restart first so the engine holds no handle on the
        // tier and does not rebuild its index over vanishing files
        await this.restart();
        let removed = 0;
        for (const root of this.deps.engine.cacheDirs()) {
          removed += await this.clearDir(root);
        }
        return `restarted, removed ${removed} cache dir${removed === 1 ? "" : "s"}`;
      }
      case "historyClear": {
        const n = this.deps.history.clear();
        this.deps.sampler.forgetLastRequest();
        return `removed ${n} sample${n === 1 ? "" : "s"}`;
      }
    }
  }

  private async restart(): Promise<string> {
    const label = this.deps.engine.serviceLabel();
    if (!label) throw new ActionError(403, "engine is not a launchd service");
    const target = `gui/${this.uid}/${label}`;
    const r = await this.spawn(["launchctl", "kickstart", "-k", target]);
    if (r.code !== 0) {
      throw new Error(
        `launchctl kickstart ${target} exited ${r.code}${r.stderr ? `: ${r.stderr}` : ""}`,
      );
    }
    return `restarted ${label}`;
  }
}
