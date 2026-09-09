// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The shell components rendered to a string, without a DOM: the class
// names and structure style.css depends on, and the signals they read.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Footer } from "../../src/ui/shell/Footer.tsx";
import { Header } from "../../src/ui/shell/Header.tsx";
import { Pill } from "../../src/ui/shell/Pill.tsx";
import { connection, type Snapshot, snapshot } from "../../src/ui/store.ts";

describe("shell", () => {
  test("header marks the current page and shows the pill only on chat", () => {
    const monitor = render(<Header page="monitor" />);
    expect(monitor).toContain('<div class="wordmark"><svg class="mark"');
    expect(monitor).toContain('<a href="/" class="active">Monitor</a>');
    expect(monitor).toContain('<a href="/requests">Requests</a>');
    expect(monitor).not.toContain('class="pill');
    const chat = render(<Header page="chat" />);
    expect(chat).toContain('<a href="/chat" class="active">Chat</a>');
    expect(chat).toContain('<span class="grow"></span><span class="pill');
  });

  test("pill follows the connection signal", () => {
    connection.value = "connecting";
    expect(render(<Pill />)).toBe('<span class="pill">connecting</span>');
    connection.value = "live";
    expect(render(<Pill />)).toBe('<span class="pill live">live</span>');
    connection.value = "reconnecting";
    expect(render(<Pill />)).toBe('<span class="pill err">reconnecting</span>');
  });

  test("footer shows the version once the snapshot is in", () => {
    snapshot.value = null;
    expect(render(<Footer />)).toContain(">mlx-spy</a>");
    snapshot.value = { version: "v0.0.0-dev" } as Partial<Snapshot> as Snapshot;
    expect(render(<Footer />)).toContain(">mlx-spy v0.0.0-dev</a>");
    expect(render(<Footer />)).toContain('class="footlink"');
  });
});
