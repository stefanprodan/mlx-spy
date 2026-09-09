// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The page's entry, bundled by Bun from index.html. The header and the
// footer are Preact components rendered into the shell; the three views
// are still the static markup app.ts drives, until each moves in its own
// milestone (plans/26.09.09-preact-plan.md). The socket opens last, once
// every subscriber is in place.

import { render } from "preact";
import "./app.ts";
import { Footer } from "./shell/Footer.tsx";
import { Header } from "./shell/Header.tsx";
import { connect, pageOf } from "./store.ts";

const page = pageOf(location.pathname);
render(<Header page={page} />, document.getElementById("top")!);
render(<Footer />, document.getElementById("foot")!);
connect();
