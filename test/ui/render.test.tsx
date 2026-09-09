// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { Pull } from "../../src/pulls.ts";
import type { LastRequest } from "../../src/requests.ts";
import type { Sample } from "../../src/sample.ts";
import { Event } from "../../src/ui/monitor/Event.tsx";
import { Models } from "../../src/ui/monitor/Models.tsx";
import { RequestBar } from "../../src/ui/monitor/RequestBar.tsx";
import { Tiles } from "../../src/ui/monitor/Tiles.tsx";
import { PLACEHOLDER, type Tile } from "../../src/ui/monitor/tiles.ts";
import { Requests, requests } from "../../src/ui/requests/Requests.tsx";
import type { Snapshot } from "../../src/ui/store.ts";
import { busy, connection, event, pulls, sample } from "../../src/ui/store.ts";

const startedAt = new Date(2026, 8, 9, 10, 0, 0).getTime();
const last: LastRequest = {
  startedAt,
  finishedAt: startedAt + 5000,
  count: 1,
  cancelled: false,
  generated: 80,
  promptTokens: 1000,
  prefillTokens: 250,
  prefillMs: 1000,
  decodeMs: 4000,
  ttftMs: 1200,
  model: "org/model",
};
const live = {
  t: startedAt + 3000,
  engineUp: true,
  request: { startedAt, prefillMs: 1000, decodeMs: 2000 },
  lastRequest: last,
  requestsRunning: 1,
  requestsWaiting: 0,
  requestsPrefilling: 0,
  inflightTokens: 64,
  prefillTps: 128,
  decodeTps: 32,
} as Partial<Sample> as Sample;

describe("request components", () => {
  test("request bar keeps the CSS structure and inline segment widths", () => {
    sample.value = live;
    const html = render(<RequestBar />);
    expect(html).toContain('<div class="spark request">');
    expect(html).toContain('<div class="cur-head">');
    expect(html).toContain('<span class="cur-state on">in flight</span>');
    expect(html).toContain('<div class="cur-bar running">');
    expect(html).toContain(
      '<span class="pf" style="width:33.33333333333333%;"></span>',
    );
    expect(html).toContain(
      '<span class="dc" style="width:66.66666666666666%;"></span>',
    );
    expect(html).toContain('<div class="cur-foot">');
    expect(html).toContain('<span class="cur-pf">');
    expect(html).toContain('<span class="cur-dc">');
    expect(html).toContain('<span class="cur-total">3s · decoding</span>');
  });

  test("requests renders its table, row details and blank line", () => {
    connection.value = "live";
    busy.value = null;
    event.value = {
      t: startedAt,
      action: "requestsClear",
      model: null,
      ok: true,
      ms: 120,
      detail: "deleted 1 request",
    };
    requests.value = [];
    const empty = render(<Requests />);
    expect(empty).toContain('<span class="pill live">live</span>');
    expect(empty).toContain('<section class="card" id="requests-live">');
    expect(empty).toContain('<table id="requests" hidden>');
    expect(empty).toContain('<th class="when">Finished</th>');
    expect(empty).toContain('<th class="model">Model</th>');
    expect(empty).toContain('<th class="num wide">Prefill</th>');
    expect(empty).toContain('<p class="blank">No requests yet.</p>');
    // the action line belongs to the monitor
    expect(empty).not.toContain('class="event');

    requests.value = [last];
    const filled = render(<Requests />);
    expect(filled).toContain('<table id="requests">');
    expect(filled).toContain('<td class="when"><span class="chev"></span>');
    expect(filled).toContain('<td class="model" title="org/model">model</td>');
    expect(filled).toContain('<td class="num cached">75%</td>');
    expect(filled).toContain('<td class="num wide">1.0 s');
    expect(filled).toContain('<tr class="detail" hidden>');
    expect(filled).toContain('<div class="dgrid">');
    expect(filled).toContain('<span class="k">Outcome</span>');
    expect(filled).toContain('<p class="blank" hidden>No requests yet.</p>');
  });

  test("tiles keep the CSS structure, the bars and the warn part", () => {
    const list: Tile[] = [
      ...PLACEHOLDER.slice(0, 1).map((t) => ({
        ...t,
        value: "5",
        sub: [{ warn: "1 cancelled" }, " · ", "TTFT avg 0.6 s"],
      })),
      {
        key: "mem",
        label: "Memory",
        value: "20",
        unit: "GB",
        none: false,
        bar: { pct: 80, level: "warn", off: false },
        sub: ["72 GB free of 128"],
      },
      PLACEHOLDER[6],
    ];
    const html = render(<Tiles tiles={list} />);
    expect(html).toContain(
      '<div class="tiles"><div class="tile"><div class="lbl">Requests</div><div class="val"><span>5</span><span class="unit">served</span></div><div class="sub"><span class="warn">1 cancelled</span> · TTFT avg 0.6 s</div></div>',
    );
    expect(html).toContain(
      '<div class="bar"><div class="fill warn" style="width:80%;"></div></div>',
    );
    expect(html).toContain(
      '<div class="val"><span class="none">–</span><span class="unit">GB est.</span></div><div class="bar off"><div class="fill" style="width:0%;"></div></div>',
    );
  });

  test("models table keeps the row structure and the buttons", () => {
    const snap = {
      engine: { capabilities: ["load", "unload"] },
      sample: { engineUp: true },
      models: [
        {
          id: "org/one",
          loaded: true,
          state: "ready",
          bytesResident: 2 ** 30,
          bytesOnDisk: 2 ** 30,
          contextLength: 262144,
          capabilities: [],
          favorite: true,
        },
        {
          id: "two",
          loaded: false,
          state: "unloaded",
          bytesResident: 0,
          bytesOnDisk: 3 * 2 ** 30,
          contextLength: null,
          capabilities: [],
        },
      ],
    } as unknown as Snapshot;
    const html = render(<Models snap={snap} />);
    expect(html).toContain(
      '<section class="card models"><table id="models"><tbody><tr class="ready"><td class="name" title="org/one"><div><span class="dot ready"></span><span class="owner">org/</span><a class="model" href="https://huggingface.co/org/one" target="_blank" rel="noopener">one</a></div></td><td class="meta">1.0 GB · 256K ctx</td><td class="state ready">ready</td><td class="act">',
    );
    expect(html).toContain('class="ibtn on" title="Daily driver"');
    expect(html).toContain('class="ibtn danger" title="Unload"');
    expect(html).toContain(
      '<tr><td class="name" title="two"><div><span class="dot "></span><span class="owner"></span><a class="model" href="https://huggingface.co/two"',
    );
    expect(html).toContain('<td class="meta">3.0 GB</td>');
    expect(html).toContain('class="ibtn" title="Load"');
    expect(html).toContain('<p class="blank" hidden>');
    const empty = render(
      <Models
        snap={
          {
            ...snap,
            models: [],
            sample: { engineUp: false },
          } as unknown as Snapshot
        }
      />,
    );
    expect(empty).toContain('<p class="blank">Engine unreachable.</p>');
  });
});

describe("download rows", () => {
  const base: Pull = {
    id: 7,
    repo: "org/new",
    revision: "abc",
    dir: "/models/org/new",
    status: "running",
    bytesTotal: 4 * 2 ** 30,
    bytesDone: 2 ** 30,
    filesTotal: 3,
    filesDone: 1,
    file: "model.safetensors",
    error: null,
    createdAt: startedAt,
    updatedAt: startedAt,
    finishedAt: null,
    speedBps: 64 * 2 ** 20,
  };
  const snap = {
    engine: { capabilities: ["load"] },
    sample: { engineUp: true },
    models: [
      {
        id: "org/new",
        loaded: false,
        state: "unloaded",
        bytesResident: 0,
        bytesOnDisk: 4 * 2 ** 30,
        contextLength: null,
        capabilities: [],
      },
    ],
  } as unknown as Snapshot;

  test("a running pull is a row with a bar, the bytes and a cancel", () => {
    pulls.value = [base];
    const html = render(<Models snap={snap} />);
    expect(html).toContain(
      '<tr class="pull running"><td class="name" title="org/new: model.safetensors"><div><span class="dot loading"></span><span class="owner">org/</span><a class="model" href="https://huggingface.co/org/new" target="_blank" rel="noopener">new</a></div><div class="bar"><span class="fill" style="width:25%;"></span></div></td><td class="meta">1.0 / 4.0 GB · 64 MB/s · 48 s left</td><td class="state running">downloading</td><td class="act">',
    );
    expect(html).toContain('class="ibtn trash danger" title="Delete"');
    expect(html).toContain('class="ibtn" title="Pause"');
    // the model row follows the download row
    expect(html).toContain('<tr><td class="name" title="org/new">');
  });

  test("a stopped pull offers resume and delete; a listed one hides", () => {
    pulls.value = [{ ...base, status: "failed", error: "sha256 mismatch" }];
    const html = render(<Models snap={snap} />);
    expect(html).toContain('<tr class="pull failed" title="sha256 mismatch">');
    expect(html).toContain('<div class="bar" hidden>');
    expect(html).toContain('<td class="state failed">failed</td>');
    expect(html).toContain('class="ibtn" title="Resume"');
    expect(html).toContain('class="ibtn trash danger" title="Delete"');
    pulls.value = [{ ...base, status: "done", bytesDone: base.bytesTotal }];
    expect(render(<Models snap={snap} />)).not.toContain('class="pull');
    pulls.value = [];
  });
});

describe("event line", () => {
  const base = { t: startedAt, model: "org/model", ms: 120, detail: "x" };
  test("a success shows nothing: the list and the uptime already do", () => {
    event.value = { ...base, action: "load", ok: true };
    expect(render(<Event />)).toBe('<div class="event" hidden></div>');
  });
  test("a failure shows the action and the reason", () => {
    event.value = { ...base, action: "load", ok: false, detail: "HTTP 409" };
    const html = render(<Event />);
    expect(html).toContain('<div class="event err"><span class="when">');
    expect(html).toContain("load org/model failed: HTTP 409</div>");
  });
  test("a later success clears the failure", () => {
    event.value = { ...base, action: "load", ok: false, detail: "HTTP 409" };
    event.value = { ...base, t: startedAt + 1, action: "load", ok: true };
    expect(render(<Event />)).toBe('<div class="event" hidden></div>');
  });
  test("a failed download shows its error", () => {
    event.value = null;
    pulls.value = [
      {
        id: 1,
        repo: "org/new",
        revision: "abc",
        dir: "/m",
        status: "failed",
        bytesTotal: 1,
        bytesDone: 0,
        filesTotal: 1,
        filesDone: 0,
        file: null,
        error: "not enough disk",
        createdAt: startedAt,
        updatedAt: startedAt,
        finishedAt: startedAt,
        speedBps: null,
      },
    ];
    expect(render(<Event />)).toContain(
      "download org/new failed: not enough disk</div>",
    );
    pulls.value = [];
    expect(render(<Event />)).toBe('<div class="event" hidden></div>');
  });
});
