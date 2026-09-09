// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { LastRequest } from "../../src/requests.ts";
import type { Sample } from "../../src/sample.ts";
import { RequestBar } from "../../src/ui/monitor/RequestBar.tsx";
import { Requests, requests } from "../../src/ui/requests/Requests.tsx";
import { busy, connection, event, sample } from "../../src/ui/store.ts";

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

  test("requests renders its table, row details, blank line, and event", () => {
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
    expect(empty).toContain('<div class="event"><span class="when">');

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
});
