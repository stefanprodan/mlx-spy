// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export type HostMemory = {
  total: number;
  free: number;
  active: number;
  inactive: number;
  wired: number;
  speculative: number;
  compressed: number; // pages held by the compressor
};

export type ProcessMemory = {
  footprint: number; // phys_footprint, what Activity Monitor calls "Memory"
  rss: number;
  startedAt: number; // unix ms the process started, 0 when unknown
  cpuNs: number; // user + system CPU time so far, in nanoseconds
};

export type DiskDir = {
  path: string;
  bytes: number; // allocated bytes, like du
  modelId: string | null; // filled by the log tail (milestone 6)
};

export interface HostProbes {
  hostMemory(): HostMemory | null;
  processMemory(pid: number): ProcessMemory | null;
  findPid(names: string[]): number | null;
  pidMatches(pid: number, names: string[]): boolean;
}

// What a tick attaches to the Sample; disk and pid are carried between
// refreshes by the sampler.
export type HostSnapshot = {
  mem: HostMemory | null;
  pid: number | null;
  proc: ProcessMemory | null;
  // the engine process's CPU over the last tick, percent of one core as
  // top and Activity Monitor show it; null until two readings exist
  cpuPct: number | null;
  disk: DiskDir[];
};

export const EMPTY_HOST: HostSnapshot = {
  mem: null,
  pid: null,
  proc: null,
  cpuPct: null,
  disk: [],
};
