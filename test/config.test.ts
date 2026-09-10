// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { ConfigStore } from "../src/config.ts";
import type { CatalogModel } from "../src/engine/openrouter.ts";

const free: CatalogModel = {
  id: "org/free:free",
  name: "Org: Free",
  contextLength: 262144,
  promptPrice: 0,
  completionPrice: 0,
  tools: true,
  reasoning: true,
};
const paid: CatalogModel = {
  id: "org/paid",
  name: "Org: Paid",
  contextLength: 128000,
  promptPrice: 3,
  completionPrice: 15,
  tools: true,
  reasoning: false,
};

function setup() {
  let now = 1000;
  const db = new Database(":memory:", { strict: true });
  const store = new ConfigStore(db, () => now);
  return {
    store,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("remote models", () => {
  test("adds once, lists in insertion order, gets and removes", () => {
    const s = setup();
    expect(s.store.add("openrouter", paid)).toBe(true);
    s.setNow(2000);
    expect(s.store.add("openrouter", free)).toBe(true);
    expect(s.store.add("openrouter", free)).toBe(false);
    expect(s.store.list("openrouter").map((m) => m.id)).toEqual([
      paid.id,
      free.id,
    ]);
    expect(s.store.get("openrouter", free.id)).toEqual({
      provider: "openrouter",
      ...free,
      addedAt: 2000,
      checkedAt: 2000,
      missing: false,
    });
    expect(s.store.list("mlxserve")).toEqual([]);
    expect(s.store.remove("openrouter", paid.id)).toBe(true);
    expect(s.store.remove("openrouter", paid.id)).toBe(false);
    expect(s.store.list("openrouter").map((m) => m.id)).toEqual([free.id]);
  });

  test("a refresh updates prices, windows and flags and marks the rows the catalog dropped", () => {
    const s = setup();
    s.store.add("openrouter", paid);
    s.setNow(2000);
    s.store.add("openrouter", free);
    s.setNow(5000);
    const catalog = new Map<string, CatalogModel>([
      [
        paid.id,
        {
          ...paid,
          name: "Org: Paid v2",
          promptPrice: 2.5,
          contextLength: 200000,
          reasoning: true,
        },
      ],
    ]);
    expect(s.store.refresh("openrouter", catalog)).toBe(1);
    const [p, f] = s.store.list("openrouter");
    expect(p).toMatchObject({
      name: "Org: Paid v2",
      promptPrice: 2.5,
      completionPrice: 15,
      contextLength: 200000,
      reasoning: true,
      checkedAt: 5000,
      missing: false,
    });
    expect(f).toMatchObject({ ...free, checkedAt: 2000, missing: true });
    // back in the catalog: found again, prices from it
    catalog.set(free.id, { ...free, promptPrice: 0.1, completionPrice: 0.2 });
    s.setNow(6000);
    expect(s.store.refresh("openrouter", catalog)).toBe(2);
    expect(s.store.get("openrouter", free.id)).toMatchObject({
      promptPrice: 0.1,
      checkedAt: 6000,
      missing: false,
    });
  });
});
