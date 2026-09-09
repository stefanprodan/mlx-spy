// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Hugging Face Hub as mlx-spy reads it: one model API call for the file
// list at a commit, then one resolve URL per file. The parsers are pure and
// tested on a recorded body; fetchRepo is the only I/O here.

const HUB = "https://huggingface.co";
// the downloader's in-flight suffix; a repo file with that name is refused
export const PART_SUFFIX = ".mlx-spy-part";
const TIMEOUT_MS = 20_000;

// A repo id is <owner>/<name>: the Hub's own rule is letters, digits, dot,
// dash and underscore, and neither side may be a dot path.
const PART = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type HubFile = {
  path: string;
  size: number;
  // the LFS content hash; null for the small files git stores itself
  sha256: string | null;
};

export type HubRepo = {
  id: string;
  // the commit the listing describes; every file resolves against it
  revision: string;
  files: HubFile[];
};

export class HubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// "org/name", "hf.co/org/name" or a huggingface.co URL with anything after
// the name (a /tree/main, a query) → "org/name"; null when it is not one.
export function parseRepoId(input: string): string | null {
  let s = input.trim();
  for (const prefix of [
    "https://huggingface.co/",
    "http://huggingface.co/",
    "huggingface.co/",
    "https://hf.co/",
    "hf.co/",
  ]) {
    if (s.toLowerCase().startsWith(prefix)) {
      s = s.slice(prefix.length);
      break;
    }
  }
  const parts = s.split("/").filter((p) => p !== "");
  if (parts.length < 2) return null;
  const [owner, name] = parts;
  if (!PART.test(owner) || !PART.test(name)) return null;
  // a URL keeps only its first two segments; a bare id must be exactly two
  if (
    parts.length > 2 &&
    !/^(https?:\/\/)?(huggingface|hf)\.co\//i.test(input.trim())
  ) {
    return null;
  }
  return `${owner}/${name}`;
}

// The /api/models/<repo>?blobs=true body → the files to download.
// .gitattributes is git's LFS bookkeeping, not part of the model.
export function parseRepoFiles(body: any): HubFile[] {
  const siblings: any[] = Array.isArray(body?.siblings) ? body.siblings : [];
  const files: HubFile[] = [];
  for (const s of siblings) {
    const path = s?.rfilename;
    if (typeof path !== "string" || path === "") continue;
    if (path === ".gitattributes") continue;
    // a path that escapes the model directory is refused, not sanitised;
    // so is a name that would collide with a download in flight
    if (
      path.endsWith(PART_SUFFIX) ||
      path.split("/").some((p) => p === "" || p === "." || p === "..")
    ) {
      continue;
    }
    const size =
      typeof s.size === "number" && Number.isFinite(s.size) && s.size >= 0
        ? s.size
        : typeof s?.lfs?.size === "number"
          ? s.lfs.size
          : null;
    if (size === null) continue;
    const sha =
      typeof s?.lfs?.sha256 === "string" && /^[0-9a-f]{64}$/.test(s.lfs.sha256)
        ? s.lfs.sha256
        : null;
    files.push({ path, size, sha256: sha });
  }
  return files;
}

export function resolveUrl(
  repo: string,
  revision: string,
  path: string,
  hub = HUB,
): string {
  const segments = path.split("/").map(encodeURIComponent).join("/");
  return `${hub}/${repo}/resolve/${encodeURIComponent(revision)}/${segments}`;
}

export function hubHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": "mlx-spy",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

// The repo's file list at its current commit. A 401 or 403 is a gated or
// private repo (the token is the fix), a 404 an unknown id.
export async function fetchRepo(
  repo: string,
  token: string | null,
  signal?: AbortSignal,
  hub = HUB,
): Promise<HubRepo> {
  const url = `${hub}/api/models/${repo}?blobs=true`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: hubHeaders(token),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
        : AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new HubError(
      502,
      `huggingface.co: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new HubError(
      403,
      `${repo} is gated or private${token ? "" : "; add hf.key to the secrets directory"}`,
    );
  }
  if (res.status === 404) throw new HubError(404, `${repo} not found`);
  if (!res.ok) throw new HubError(502, `huggingface.co: HTTP ${res.status}`);
  const body: any = await res.json().catch(() => null);
  const revision = body?.sha;
  if (typeof revision !== "string" || revision === "") {
    throw new HubError(502, `huggingface.co: no commit for ${repo}`);
  }
  const files = parseRepoFiles(body);
  if (files.length === 0) {
    throw new HubError(400, `${repo} has no files to download`);
  }
  return { id: typeof body.id === "string" ? body.id : repo, revision, files };
}
