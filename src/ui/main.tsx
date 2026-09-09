// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The page entry keeps the static monitor and chat views during the staged
// migration. Requests is a Preact root; the monitor request bar is another
// root inside its otherwise imperative card.

import { render } from "preact";
import "./app.ts";
import { RequestBar } from "./monitor/RequestBar.tsx";
import { Requests } from "./requests/Requests.tsx";
import { Footer } from "./shell/Footer.tsx";
import { Header } from "./shell/Header.tsx";
import { connect, pageOf } from "./store.ts";

const page = pageOf(location.pathname);
render(<Header page={page} />, document.getElementById("top")!);
render(<Footer />, document.getElementById("foot")!);
if (page === "requests") {
  document.getElementById("view-monitor")!.hidden = true;
  const view = document.getElementById("view-requests")!;
  view.hidden = false;
  render(<Requests />, view);
} else if (page === "monitor") {
  render(<RequestBar />, document.getElementById("request-bar")!);
}
connect();
