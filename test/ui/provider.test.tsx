// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chat page with two providers: the picker's hosted group, the
// per-provider capacity behind Send, the Settings page in its states, and
// the cost on the numbers line.

import { afterAll, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { RemoteModel } from "../../src/config.ts";
import {
  armed,
  Config,
  checkError,
  checked,
  enabled,
  refreshed,
} from "../../src/ui/chat/Config.tsx";
import { ModelPicker, priceLabel } from "../../src/ui/chat/ModelPicker.tsx";
import { doneStats, usd } from "../../src/ui/chat/stats.ts";
import {
  canSend,
  defaultModel,
  draft,
  modelInfo,
  runs,
  slotsOf,
  state,
} from "../../src/ui/chat/store.ts";
import { models, remoteModels } from "../../src/ui/store.ts";
import { row, stats } from "./stats.test.ts";

const free: RemoteModel = {
  provider: "openrouter",
  id: "nvidia/nemotron-3-super-120b-a12b:free",
  name: "NVIDIA: Nemotron 3 Super (free)",
  contextLength: 262144,
  promptPrice: 0,
  completionPrice: 0,
  tools: true,
  reasoning: true,
  addedAt: 1,
  checkedAt: 1,
  missing: false,
};
const paid: RemoteModel = {
  ...free,
  id: "anthropic/claude-sonnet-4.5",
  name: "Anthropic: Claude Sonnet 4.5",
  contextLength: 1000000,
  promptPrice: 3,
  completionPrice: 15,
  reasoning: false,
  missing: true,
};
const local = {
  id: "org/local",
  loaded: true,
  state: "ready",
  bytesResident: 2 ** 30,
  bytesOnDisk: 2 ** 30,
  contextLength: 32768,
  capabilities: ["chat"],
};
const both = { mlxserve: 1, openrouter: 4 };
const send = (chatId: string, provider: "mlxserve" | "openrouter") => ({
  chatId,
  provider,
  firstMessageId: 1,
  messageId: 1,
  phase: "running" as const,
});

// the signals are module singletons shared with the other test files
afterAll(() => {
  models.value = [];
  remoteModels.value = [];
  runs.value = { limits: { mlxserve: 1, openrouter: 0 }, sends: [] };
  draft.value = { ...draft.value, provider: "mlxserve", model: "" };
  state.value = null;
});

describe("price label", () => {
  test("free, dollars per million, and nothing when unknown", () => {
    expect(priceLabel(0, 0)).toBe("free");
    expect(priceLabel(3, 15)).toBe("$3.00 / $15");
    expect(priceLabel(0.3, 1.2)).toBe("$0.30 / $1.20");
    expect(priceLabel(null, 1)).toBe("");
    expect(usd(0.0012)).toBe("$0.0012");
    expect(usd(0.25)).toBe("$0.25");
  });
});

describe("the picker", () => {
  test("lists the engine's models, then the hosted group with prices", () => {
    models.value = [local];
    remoteModels.value = [free, paid];
    runs.value = { limits: both, sends: [] };
    state.value = null;
    draft.value = { ...draft.value, provider: "openrouter", model: free.id };
    const html = render(<ModelPicker anchor={null} onClose={() => {}} />);
    expect(html).toContain('<div class="pop" role="listbox">');
    expect(html).toContain("org/</span>local");
    expect(html).toContain("<h4>OpenRouter</h4>");
    expect(html).toContain('class="on remote"');
    expect(html).toContain('<span class="size">free</span>');
    expect(html).toContain('<span class="size">$3.00 / $15</span>');
    expect(html).not.toContain("Add models in Settings");
  });

  test("with a key and no models the group is one line to Settings; without a key nothing", () => {
    models.value = [local];
    remoteModels.value = [];
    runs.value = { limits: both, sends: [] };
    draft.value = { ...draft.value, provider: "mlxserve", model: local.id };
    expect(render(<ModelPicker anchor={null} onClose={() => {}} />)).toContain(
      "Add models in Settings",
    );
    runs.value = { limits: { mlxserve: 1, openrouter: 0 }, sends: [] };
    const html = render(<ModelPicker anchor={null} onClose={() => {}} />);
    expect(html).not.toContain("OpenRouter");
    expect(html).toContain('class="on"');
  });
});

describe("capacity per provider", () => {
  test("a full engine slot does not stop a hosted chat, and the other way round", () => {
    models.value = [local];
    remoteModels.value = [free];
    state.value = null;
    const r = { limits: both, sends: [send("x", "mlxserve")] };
    runs.value = r;
    expect(slotsOf(r, "mlxserve")).toEqual({ taken: 1, limit: 1 });
    expect(slotsOf(r, "openrouter")).toEqual({ taken: 0, limit: 4 });
    draft.value = { ...draft.value, provider: "mlxserve", model: local.id };
    expect(canSend.value).toBe(false);
    draft.value = { ...draft.value, provider: "openrouter", model: free.id };
    expect(canSend.value).toBe(true);
    runs.value = {
      limits: both,
      sends: ["a", "b", "c", "d"].map((id) => send(id, "openrouter")),
    };
    expect(canSend.value).toBe(false);
    draft.value = { ...draft.value, provider: "mlxserve", model: local.id };
    expect(canSend.value).toBe(true);
    runs.value = { limits: { mlxserve: 1, openrouter: 0 }, sends: [] };
    draft.value = { ...draft.value, provider: "openrouter", model: free.id };
    expect(canSend.value).toBe(false);
  });

  test("model lookup and the default follow the provider", () => {
    models.value = [local];
    remoteModels.value = [free];
    expect(modelInfo("openrouter", free.id)).toMatchObject({
      id: free.id,
      loaded: true,
      contextLength: 262144,
      capabilities: ["chat", "tool_use"],
    });
    expect(modelInfo("mlxserve", free.id)).toBeNull();
    expect(modelInfo("openrouter", local.id)).toBeNull();
    expect(defaultModel()).toEqual({ provider: "mlxserve", model: local.id });
    models.value = [];
    expect(defaultModel()).toEqual({ provider: "openrouter", model: free.id });
    remoteModels.value = [];
    expect(defaultModel()).toEqual({ provider: "mlxserve", model: "" });
  });
});

describe("the numbers line", () => {
  test("shows a hosted reply's cost after the tokens, free when nothing was charged", () => {
    const remote = (id: number, cost: number) =>
      row(id, "assistant", {
        stats: { ...stats(10)!, prefillMs: null, decodeMs: null, cost },
        finishedAt: row(0, "user").createdAt + 2000,
      });
    const values = (items: { label: string; value: string }[] | null) =>
      items?.map((i) => `${i.label} ${i.value}`.trim());
    // an upstream that does not cache reports zero; that says nothing
    expect(values(doneStats([row(1, "user"), remote(2, 0)]))).toEqual([
      "10 tok",
      "free",
      "2.0 s",
    ]);
    expect(
      values(doneStats([row(1, "user"), remote(2, 0.001), remote(3, 0.0005)])),
    ).toEqual(["20 tok", "$0.0015", "2.0 s"]);
    const cached = row(2, "assistant", {
      stats: { ...stats(10)!, prefillMs: null, decodeMs: null, cost: 0.001 },
      finishedAt: row(0, "user").createdAt + 2000,
    });
    cached.stats!.cachedTokens = 5;
    cached.stats!.promptTokens = 10;
    expect(values(doneStats([row(1, "user"), cached]))).toContain("cache 50%");
    // the engine's rows have no cost and show none
    expect(
      values(
        doneStats([row(1, "user"), row(2, "assistant", { stats: stats(10) })]),
      ),
    ).not.toContain("free");
  });
});

describe("the Settings page", () => {
  const page = () => render(<Config onList={() => {}} />);
  test("before the answer, without a key, and with rows", () => {
    enabled.value = null;
    refreshed.value = null;
    remoteModels.value = [];
    let html = page();
    expect(html).toContain('<section class="conv config">');
    expect(html).toContain('<span class="title">Settings</span>');
    expect(html).toContain(
      '<div class="cfg"><h3>OpenRouter<span class="status" title></span></h3></div>',
    );

    enabled.value = false;
    html = page();
    expect(html).toContain('<p class="none">No OpenRouter key.');
    expect(html).not.toContain('<table class="remote">');

    enabled.value = true;
    refreshed.value = { at: Date.now() - 5000, error: null };
    remoteModels.value = [free, paid];
    checked.value = null;
    checkError.value = "";
    armed.value = paid.id;
    html = page();
    expect(html).toContain("prices as of");
    expect(html).toContain('<form class="addrow">');
    expect(html).toContain('<table class="remote">');
    expect(html).toContain('<td class="price">free</td>');
    expect(html).toContain('<tr class="missing">');
    expect(html).toContain('<td class="price">not in catalog</td>');
    expect(html).toContain('class="btn danger">Confirm</button>');
    expect(html).toContain('class="btn">Remove</button>');
    expect(html).toContain("262K ctx");
    remoteModels.value = [{ ...free, contextLength: 1310720 }];
    expect(page()).toContain("1.3M ctx");
    remoteModels.value = [{ ...free, contextLength: 1000000 }];
    expect(page()).toContain("1M ctx");
    remoteModels.value = [free, paid];

    refreshed.value = { at: Date.now(), error: "OpenRouter unreachable: x" };
    remoteModels.value = [];
    checked.value = { ...free, id: "a/b" };
    checkError.value = "";
    html = page();
    expect(html).toContain("OpenRouter unreachable");
    expect(html).toContain('<div class="preview">');
    expect(html).toContain('class="btn primary">Add</button>');
    expect(html).toContain('<tr class="blank">');
    armed.value = null;
  });
});
