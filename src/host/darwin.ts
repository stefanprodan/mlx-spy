// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// macOS host probes over bun:ffi: host memory from Mach, the engine process's
// footprint from libproc, and pid discovery by executable name. Read-only,
// spawns nothing. dlopen of the system dylibs only happens inside
// createDarwinProbes(), which the facade calls on darwin alone.
//
// Struct offsets below were verified with offsetof() on macOS 26 (the C probe
// is in the milestone 3 notes); they are load-bearing.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { cpus } from "node:os";
import type { HostMemory, HostProbes, ProcessMemory } from "./types.ts";

export function createDarwinProbes(): HostProbes {
  // struct rusage_info_v4, 296 bytes: ri_user_time@16, ri_system_time@24
  // (mach absolute time units), ri_resident_size@64, ri_phys_footprint@72
  const RUSAGE_INFO_V4 = 4;
  const RUSAGE_V4_SIZE = 296;
  const RI_USER_TIME = 16;
  const RI_SYSTEM_TIME = 24;
  const RI_RESIDENT_SIZE = 64;
  const RI_PHYS_FOOTPRINT = 72;
  // vm_statistics64_data_t: 248 bytes on macOS 26 (HOST_VM_INFO64_COUNT 62);
  // the kernel fills what it has and writes the count it used back. The
  // page counts are 32-bit natural_t: free@0, active@4, inactive@8, wire@12,
  // speculative@92, compressor_page_count@128
  const HOST_VM_INFO64 = 4;
  const VM_STATS_SIZE = 248;
  // struct proc_bsdinfo, 136 bytes: pbi_start_tvsec@120, pbi_start_tvusec@128
  const PROC_PIDTBSDINFO = 3;
  const BSDINFO_SIZE = 136;
  const PBI_START_TVSEC = 120;
  const PBI_START_TVUSEC = 128;

  const libproc = dlopen("/usr/lib/libproc.dylib", {
    proc_listallpids: {
      args: [FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    proc_pidpath: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    proc_pid_rusage: {
      args: [FFIType.i32, FFIType.i32, FFIType.ptr],
      returns: FFIType.i32,
    },
    proc_pidinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
  });

  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    mach_host_self: { args: [], returns: FFIType.u32 },
    host_statistics64: {
      args: [FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    sysctlbyname: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
    mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
  });

  // mach absolute time units to nanoseconds (125/3 on Apple Silicon)
  const timebase = new Uint32Array(2);
  libc.symbols.mach_timebase_info(ptr(timebase));
  const nsPerUnit = timebase[1] ? timebase[0] / timebase[1] : 1;

  const sysctlU64 = (name: string): number => {
    const cname = new TextEncoder().encode(`${name}\0`);
    const out = new BigUint64Array(1);
    const size = new BigUint64Array([BigInt(out.byteLength)]);
    const r = libc.symbols.sysctlbyname(
      ptr(cname),
      ptr(out),
      ptr(size),
      null,
      0n,
    );
    return r === 0 ? Number(out[0]) : 0;
  };
  const pageSize = sysctlU64("hw.pagesize") || 16384;
  const total = sysctlU64("hw.memsize");
  const host = libc.symbols.mach_host_self();

  const vmStats = new Uint8Array(VM_STATS_SIZE);
  const vmView = new DataView(vmStats.buffer);
  const hostMemory = (): HostMemory | null => {
    const count = new Uint32Array([VM_STATS_SIZE / 4]);
    const k = libc.symbols.host_statistics64(
      host,
      HOST_VM_INFO64,
      ptr(vmStats),
      ptr(count),
    );
    if (k !== 0) return null;
    const pages = (off: number) => vmView.getUint32(off, true) * pageSize;
    return {
      total,
      free: pages(0),
      active: pages(4),
      inactive: pages(8),
      wired: pages(12),
      speculative: pages(92),
      compressed: pages(128),
    };
  };

  const rusage = new Uint8Array(RUSAGE_V4_SIZE);
  const ruView = new DataView(rusage.buffer);
  const bsdinfo = new Uint8Array(BSDINFO_SIZE);
  const bsdView = new DataView(bsdinfo.buffer);
  const processMemory = (pid: number): ProcessMemory | null => {
    const r = libproc.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V4, ptr(rusage));
    if (r !== 0) return null; // gone, or not ours to inspect
    const n = libproc.symbols.proc_pidinfo(
      pid,
      PROC_PIDTBSDINFO,
      0n,
      ptr(bsdinfo),
      BSDINFO_SIZE,
    );
    const startedAt =
      n === BSDINFO_SIZE
        ? Number(bsdView.getBigUint64(PBI_START_TVSEC, true)) * 1000 +
          Math.floor(
            Number(bsdView.getBigUint64(PBI_START_TVUSEC, true)) / 1000,
          )
        : 0;
    const cpuUnits =
      ruView.getBigUint64(RI_USER_TIME, true) +
      ruView.getBigUint64(RI_SYSTEM_TIME, true);
    return {
      footprint: Number(ruView.getBigUint64(RI_PHYS_FOOTPRINT, true)),
      rss: Number(ruView.getBigUint64(RI_RESIDENT_SIZE, true)),
      startedAt,
      cpuNs: Number(cpuUnits) * nsPerUnit,
    };
  };

  const pids = new Int32Array(16384);
  const pathBuf = new Uint8Array(4096);
  const basenameOf = (pid: number): string | null => {
    const n = libproc.symbols.proc_pidpath(
      pid,
      ptr(pathBuf),
      pathBuf.byteLength,
    );
    if (n <= 0) return null;
    const path = new TextDecoder().decode(pathBuf.slice(0, n));
    return path.slice(path.lastIndexOf("/") + 1);
  };
  // First pid whose executable basename is one of `names`. Names come from
  // the adapter (the engine binary), never from a request.
  const findPid = (names: string[]): number | null => {
    const n = libproc.symbols.proc_listallpids(ptr(pids), pids.byteLength);
    for (let i = 0; i < n; i++) {
      const pid = pids[i];
      if (pid <= 0) continue;
      const base = basenameOf(pid);
      if (base && names.includes(base)) return pid;
    }
    return null;
  };
  const pidMatches = (pid: number, names: string[]): boolean => {
    const base = basenameOf(pid);
    return base !== null && names.includes(base);
  };

  return { hostMemory, processMemory, findPid, pidMatches };
}

// Chip name and core counts from sysctl, the GPU core count from the
// IORegistry's AGXAccelerator entry (what system_profiler reads). Called
// once at startup; every handle is released before returning.
export function darwinHostInfo(): {
  chip: string | null;
  cpuCores: number;
  perfCores: number | null;
  effCores: number | null;
  gpuCores: number | null;
} {
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    sysctlbyname: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
  });
  const sysctl = (name: string, bytes: number): Uint8Array | null => {
    const cname = new TextEncoder().encode(`${name}\0`);
    const out = new Uint8Array(bytes);
    const size = new BigUint64Array([BigInt(bytes)]);
    const r = libc.symbols.sysctlbyname(
      ptr(cname),
      ptr(out),
      ptr(size),
      null,
      0n,
    );
    return r === 0 ? out.slice(0, Number(size[0])) : null;
  };
  const sysctlInt = (name: string): number | null => {
    const b = sysctl(name, 8);
    if (!b) return null;
    const v = new DataView(b.buffer);
    return b.byteLength >= 8
      ? Number(v.getBigUint64(0, true))
      : v.getUint32(0, true);
  };
  const brand = sysctl("machdep.cpu.brand_string", 256);
  const chip = brand
    ? new TextDecoder().decode(brand).replace(/\0.*$/s, "").trim() || null
    : null;

  let gpuCores: number | null = null;
  try {
    const iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", {
      IOServiceMatching: { args: [FFIType.ptr], returns: FFIType.ptr },
      IOServiceGetMatchingService: {
        args: [FFIType.u32, FFIType.ptr],
        returns: FFIType.u32,
      },
      IORegistryEntryCreateCFProperty: {
        args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.ptr,
      },
      IOObjectRelease: { args: [FFIType.u32], returns: FFIType.i32 },
    });
    const cf = dlopen(
      "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
      {
        CFStringCreateWithCString: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
          returns: FFIType.ptr,
        },
        CFNumberGetValue: {
          args: [FFIType.ptr, FFIType.i32, FFIType.ptr],
          returns: FFIType.bool,
        },
        CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
      },
    );
    const kCFStringEncodingUTF8 = 0x08000100;
    const kCFNumberSInt64Type = 4;
    const cstr = (s: string) => ptr(new TextEncoder().encode(`${s}\0`));
    // IOServiceGetMatchingService consumes the matching dictionary
    const svc = iokit.symbols.IOServiceGetMatchingService(
      0,
      iokit.symbols.IOServiceMatching(cstr("AGXAccelerator")),
    );
    if (svc) {
      const key = cf.symbols.CFStringCreateWithCString(
        null,
        cstr("gpu-core-count"),
        kCFStringEncodingUTF8,
      );
      const prop = iokit.symbols.IORegistryEntryCreateCFProperty(
        svc,
        key,
        null,
        0,
      );
      if (prop) {
        const out = new BigInt64Array(1);
        if (cf.symbols.CFNumberGetValue(prop, kCFNumberSInt64Type, ptr(out))) {
          gpuCores = Number(out[0]);
        }
        cf.symbols.CFRelease(prop);
      }
      cf.symbols.CFRelease(key);
      iokit.symbols.IOObjectRelease(svc);
    }
  } catch {
    // no accelerator entry (a VM, or a future rename): the field stays null
  }

  return {
    chip,
    cpuCores: sysctlInt("hw.ncpu") ?? cpus().length,
    perfCores: sysctlInt("hw.perflevel0.physicalcpu"),
    effCores: sysctlInt("hw.perflevel1.physicalcpu"),
    gpuCores,
  };
}
