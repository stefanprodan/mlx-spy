// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Sizes of the disk cache tier without spawning du: one entry per child
// directory of each cache root (mlx-serve keeps one <fingerprint>/ per model),
// summed by allocated blocks so sparse or cloned files count as the
// filesystem does. Async so a large tier never blocks the sampler tick.

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DiskDir } from "./types.ts";

async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // vanished mid-scan (the engine evicting) is a zero; anything else
    // (permissions, descriptors, I/O) must not read as an emptied tier, so
    // it fails the scan and the sampler keeps the previous sizes
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      total += await treeBytes(p);
    } else if (e.isFile()) {
      try {
        const st = await lstat(p);
        total += st.blocks * 512;
      } catch {
        // deleted between readdir and stat
      }
    }
    // symlinks and specials are skipped: du -s counts the link itself only
  }
  return total;
}

// A missing root (engine never wrote a tier, or a dev machine) yields [].
export async function cacheDirSizes(roots: string[]): Promise<DiskDir[]> {
  const out: DiskDir[] = [];
  for (const root of roots) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const path = join(root, e.name);
      out.push({ path, bytes: await treeBytes(path), modelId: null });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
