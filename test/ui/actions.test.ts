// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { ACTION_LABEL, confirmText } from "../../src/ui/monitor/actions.ts";

const ctx = { engineName: "mlx-serve", loadedCount: 1, diskTotal: 3 * 2 ** 30 };

describe("actions", () => {
  test("every action has a label", () => {
    expect(Object.keys(ACTION_LABEL).sort()).toEqual([
      "default",
      "diskClear",
      "favorite",
      "free",
      "historyClear",
      "load",
      "requestsClear",
      "unload",
    ]);
  });

  test("the model id is a code part, never text", () => {
    const parts = confirmText("load", "org/model", ctx);
    expect(parts[0]).toBe("Load ");
    expect(parts[1]).toEqual({ code: "org/model" });
    expect(parts[2]).not.toContain("evicted");
  });

  test("two resident models warn about eviction", () => {
    const parts = confirmText("load", "org/model", { ...ctx, loadedCount: 2 });
    expect(parts[2]).toContain("least recently used one is evicted");
    expect(
      confirmText("unload", "x", { ...ctx, loadedCount: 2 })[2],
    ).not.toContain("evicted");
  });

  test("the dialog copy of the other actions", () => {
    expect(confirmText("default", "org/m", ctx)).toEqual([
      "Make ",
      { code: "org/m" },
      " the default model? It is loaded if needed and chat requests without a model go to it.",
    ]);
    expect(confirmText("unload", "org/m", ctx)).toEqual([
      "Unload ",
      { code: "org/m" },
      "? Its weights and RAM prefix cache are freed; the SSD tier is kept. A model still resident becomes the default.",
    ]);
    expect(confirmText("historyClear", null, ctx)).toEqual([
      "Delete the stored history? Every sample of the last 7 days is removed from mlx-spy's database and the graphs start over.",
    ]);
    expect(confirmText("requestsClear", null, ctx)).toEqual([
      "Delete the stored requests? The list and the last request shown in the bar are removed from mlx-spy's database.",
    ]);
  });

  test("the restart names the engine, the disk wipe its size", () => {
    expect(confirmText("free", null, ctx)).toEqual([
      "Confirm mlx-serve restart",
    ]);
    expect(confirmText("diskClear", null, ctx)[0]).toContain("(3.0 GB)");
    expect(confirmText("favorite", "x", ctx)).toEqual([]);
  });
});
