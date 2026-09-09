// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The control actions: the dialog copy (pure, tested in
// test/ui/actions.test.ts) and runAction, which confirms, posts and lets
// the /ws event show the outcome in every tab.

import { computed } from "@preact/signals";
import type { ActionEvent, ActionName } from "../../actions.ts";
import type { Capability } from "../../engine/types.ts";
import { gb } from "../format.ts";
import { confirm } from "../shell/Confirm.tsx";
import { busy, event, refreshSnapshot, setBusy, snapshot } from "../store.ts";

export const ACTION_LABEL: Record<ActionName, string> = {
  load: "load",
  unload: "unload",
  default: "set default",
  free: "restart engine",
  diskClear: "clear disk cache",
  historyClear: "clear history",
  requestsClear: "clear requests",
  favorite: "daily driver",
};

const ENGINE_NAME: Record<"mlxserve" | "omlx", string> = {
  mlxserve: "mlx-serve",
  omlx: "oMLX",
};

// facts about the engine the dialogs and the tiles need, from the snapshot
export const engineName = computed(() =>
  snapshot.value ? ENGINE_NAME[snapshot.value.engine.id] : "engine",
);
export const engineLocal = computed(
  () => snapshot.value?.engine.local ?? false,
);
export const limits = computed(() => snapshot.value?.engine.limits ?? null);
export const diskTotal = computed(
  () => snapshot.value?.disk.reduce((n, d) => n + d.bytes, 0) ?? 0,
);
export const loadedCount = computed(
  () => snapshot.value?.models.filter((m) => m.loaded).length ?? 0,
);
export const can = (c: Capability) =>
  snapshot.value?.engine.capabilities.includes(c) ?? false;

export type ConfirmContext = {
  engineName: string;
  loadedCount: number;
  diskTotal: number;
};

// A part of the dialog text: plain, or the model id shown as code. The id
// comes from the engine and is never interpreted as HTML.
export type TextPart = string | { code: string };

// The dialog copy states what happens, from the engine notes: an unload
// drops the model's RAM prefix cache, a restart drops everything but the
// SSD tier, loading past the residency cap evicts the least recently used.
export function confirmText(
  action: ActionName,
  model: string | null,
  ctx: ConfirmContext,
): TextPart[] {
  const evict =
    ctx.loadedCount >= 2
      ? " Two models are resident, so the least recently used one is evicted."
      : "";
  const m = { code: model ?? "" };
  switch (action) {
    case "load":
      return [
        "Load ",
        m,
        `? Reading the weights takes a few seconds; it becomes the default model.${evict}`,
      ];
    case "default":
      return [
        "Make ",
        m,
        ` the default model? It is loaded if needed and chat requests without a model go to it.${evict}`,
      ];
    case "unload":
      return [
        "Unload ",
        m,
        "? Its weights and RAM prefix cache are freed; the SSD tier is kept. A model still resident becomes the default.",
      ];
    case "free":
      return [`Confirm ${ctx.engineName} restart`];
    case "diskClear":
      return [
        `Restart the engine service and delete the SSD cache tier (${gb(ctx.diskTotal)} GB)? Every model is unloaded and every cached prefix is gone.`,
      ];
    case "historyClear":
      return [
        "Delete the stored history? Every sample of the last 7 days is removed from mlx-spy's database and the graphs start over.",
      ];
    case "requestsClear":
      return [
        "Delete the stored requests? The list and the last request shown in the bar are removed from mlx-spy's database.",
      ];
    case "favorite":
      return []; // a toggle, no dialog
  }
}

export async function runAction(action: ActionName, model: string | null) {
  if (busy.value) return;
  const label = ACTION_LABEL[action];
  if (action !== "favorite") {
    // the restart dialog offers the disk wipe as an option: diskClear is a
    // restart plus the deletion of the SSD tier
    const canDiskClear = can("diskClear") && engineLocal.value;
    const a = await confirm(
      confirmText(action, model, {
        engineName: engineName.value,
        loadedCount: loadedCount.value,
        diskTotal: diskTotal.value,
      }),
      label[0].toUpperCase() + label.slice(1),
      action === "free" && canDiskClear
        ? `${gb(diskTotal.value, 0)} GB`
        : undefined,
    );
    if (!a.ok) return;
    if (a.checked) action = "diskClear";
  }
  setBusy(action);
  try {
    const res = await fetch(`/api/actions/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(model ? { model } : {}),
    });
    const body = (await res.json()) as ActionEvent | { error: string };
    if (!res.ok) {
      event.value = {
        t: Date.now(),
        action,
        model,
        ok: false,
        ms: 0,
        detail: (body as { error: string }).error ?? `HTTP ${res.status}`,
      };
    }
    // a 200 carries the event; the /ws push shows it in every tab
  } catch (err) {
    event.value = {
      t: Date.now(),
      action,
      model,
      ok: false,
      ms: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    setBusy(null);
    void refreshSnapshot();
  }
}
