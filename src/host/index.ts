// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Host probe facade: the darwin FFI on macOS, a null probe elsewhere so the
// sampler and tests still run (host fields stay null/zero).

import type { HostProbes } from "./types.ts";

export const NULL_PROBES: HostProbes = {
  hostMemory: () => null,
  processMemory: () => null,
  findPid: () => null,
  pidMatches: () => false,
};

export async function createHostProbes(): Promise<HostProbes> {
  if (process.platform !== "darwin") return NULL_PROBES;
  const { createDarwinProbes } = await import("./darwin.ts");
  return createDarwinProbes();
}
