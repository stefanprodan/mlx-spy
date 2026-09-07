// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Static facts about the host mlx-spy runs on, for the Runtime section: OS
// version, chip, core counts, memory and the home volume. Read once at
// startup; only the disk space is re-read per snapshot. Spawns nothing: the
// OS version is a plist read, the chip and cores come from sysctl, the GPU
// core count from the IORegistry, the disk from statfs.

import { readFileSync, statfsSync } from "node:fs";
import { cpus, homedir, hostname, release, totalmem } from "node:os";

export type HostInfo = {
  hostname: string;
  os: string; // "macOS 26.6.2 (25G83)", or the kernel release elsewhere
  chip: string | null; // "Apple M5 Max"
  cpuCores: number;
  perfCores: number | null;
  effCores: number | null;
  gpuCores: number | null;
  memTotal: number;
  diskPath: string; // the volume reported by diskSpace()
};

export type DiskSpace = { total: number; free: number };

// The <string> that follows a <key> in a small Apple plist.
function plistString(xml: string, key: string): string | null {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(
    xml,
  );
  return m ? m[1] : null;
}

export function macosVersion(): string | null {
  try {
    const xml = readFileSync(
      "/System/Library/CoreServices/SystemVersion.plist",
      "utf8",
    );
    const name = plistString(xml, "ProductName") ?? "macOS";
    const version = plistString(xml, "ProductUserVisibleVersion");
    const build = plistString(xml, "ProductBuildVersion");
    if (!version) return null;
    return build ? `${name} ${version} (${build})` : `${name} ${version}`;
  } catch {
    return null;
  }
}

export function diskSpace(path: string): DiskSpace | null {
  try {
    const s = statfsSync(path);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

export async function hostInfo(): Promise<HostInfo> {
  const base: HostInfo = {
    hostname: hostname(),
    os: `${process.platform} ${release()}`,
    chip: null,
    cpuCores: cpus().length,
    perfCores: null,
    effCores: null,
    gpuCores: null,
    memTotal: totalmem(),
    diskPath: homedir(),
  };
  if (process.platform !== "darwin") return base;
  const { darwinHostInfo } = await import("./darwin.ts");
  return { ...base, os: macosVersion() ?? base.os, ...darwinHostInfo() };
}
