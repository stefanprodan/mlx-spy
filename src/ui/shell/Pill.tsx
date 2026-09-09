// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { connection } from "../store.ts";

// the socket's state: "connecting", "live" or "reconnecting"
export function Pill() {
  const c = connection.value;
  const cls =
    c === "live" ? "pill live" : c === "reconnecting" ? "pill err" : "pill";
  return <span class={cls}>{c}</span>;
}
