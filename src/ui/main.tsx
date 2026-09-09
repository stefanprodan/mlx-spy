// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The page's entry, bundled by Bun from index.html. The header, the footer,
// the monitor and the requests pages are Preact roots; the chat view is
// still the static markup chat.ts drives, until its own milestone
// (plans/26.09.09-preact-plan.md). The socket opens last, once every
// subscriber is in place.

import { render } from "preact";
import { mountChatPage } from "./app.ts";
import { Monitor } from "./monitor/Monitor.tsx";
import { Requests } from "./requests/Requests.tsx";
import { Footer } from "./shell/Footer.tsx";
import { Header } from "./shell/Header.tsx";
import { connect, pageOf } from "./store.ts";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const page = pageOf(location.pathname);
render(<Header page={page} />, $("top"));
render(<Footer />, $("foot"));
if (page === "monitor") {
  render(<Monitor />, $("view-monitor"));
} else if (page === "requests") {
  document.title = "mlx-spy · requests";
  $("view-monitor").hidden = true;
  $("view-requests").hidden = false;
  render(<Requests />, $("view-requests"));
} else {
  // the frame fills the viewport; the header shows the connection pill
  $("view-monitor").hidden = true;
  $("view-chat").hidden = false;
  document.querySelector(".page")!.classList.add("chat");
  mountChatPage();
}
connect();
