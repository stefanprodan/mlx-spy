// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Is the engine on this machine? Decides whether the process probe and the
// local-only actions (restart, disk clear) apply. On the MacBook dev loop the
// engine is the Studio over the tailnet, so its pid must not be looked up
// here even if a local mlx-serve happens to run.

import { hostname, networkInterfaces } from "node:os";

export function localAddresses(): Set<string> {
  const out = new Set<string>();
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) out.add(a.address.toLowerCase());
  }
  return out;
}

export function localNames(): Set<string> {
  const h = hostname().toLowerCase();
  const short = h.split(".")[0];
  return new Set([h, short, `${short}.local`]);
}

// Pure: takes the address and name sets so tests can pass their own.
export function isLocalUrl(
  url: string,
  addresses: Set<string> = localAddresses(),
  names: Set<string> = localNames(),
): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // URL keeps the brackets on IPv6 literals
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return true;
  }
  return addresses.has(host) || names.has(host);
}
