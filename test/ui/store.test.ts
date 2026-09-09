// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "../../src/engine/types.ts";
import { modelsKeyOf, pageOf } from "../../src/ui/store.ts";

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  id: "org/model",
  loaded: true,
  state: "ready",
  bytesResident: 1,
  bytesOnDisk: 2,
  contextLength: 4096,
  capabilities: ["chat"],
  ...over,
});

describe("store", () => {
  test("pageOf names the view from the path", () => {
    expect(pageOf("/")).toBe("monitor");
    expect(pageOf("/requests")).toBe("requests");
    expect(pageOf("/chat")).toBe("chat");
    expect(pageOf("/chat/abc")).toBe("chat");
    expect(pageOf("/chatter")).toBe("monitor");
    expect(pageOf("/requests/")).toBe("monitor");
  });

  test("the models key changes only with the residency picture", () => {
    const a = modelsKeyOf([model()]);
    expect(modelsKeyOf([model({ contextLength: 8192 })])).toBe(a);
    expect(modelsKeyOf([model({ state: "loading" })])).not.toBe(a);
    expect(modelsKeyOf([model({ bytesResident: 0 })])).not.toBe(a);
    expect(modelsKeyOf([model({ favorite: true })])).not.toBe(a);
    expect(modelsKeyOf([model(), model({ id: "org/other" })])).not.toBe(a);
    expect(modelsKeyOf([])).toBe("");
  });
});
