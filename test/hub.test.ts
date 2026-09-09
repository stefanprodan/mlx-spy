// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  fetchRepo,
  HubError,
  hubHeaders,
  parseRepoFiles,
  parseRepoId,
  resolveUrl,
} from "../src/hub.ts";
import hubModel from "./fixtures/hub-model.json";

describe("parseRepoId", () => {
  test("accepts ids and Hub URLs", () => {
    expect(parseRepoId("Jundot/gemma-4-E2B-it-oQ4e-mtp")).toBe(
      "Jundot/gemma-4-E2B-it-oQ4e-mtp",
    );
    expect(parseRepoId("  org/name  ")).toBe("org/name");
    expect(parseRepoId("https://huggingface.co/org/name")).toBe("org/name");
    expect(parseRepoId("https://huggingface.co/org/name/tree/main")).toBe(
      "org/name",
    );
    expect(parseRepoId("huggingface.co/org/name/")).toBe("org/name");
    expect(parseRepoId("hf.co/org/name")).toBe("org/name");
    expect(parseRepoId("HF.co/org/Na.me_1-x")).toBe("org/Na.me_1-x");
  });

  test("refuses anything else", () => {
    expect(parseRepoId("")).toBeNull();
    expect(parseRepoId("name")).toBeNull();
    expect(parseRepoId("org/name/extra")).toBeNull();
    expect(parseRepoId("org/../name")).toBeNull();
    expect(parseRepoId("../name")).toBeNull();
    expect(parseRepoId("org/.name")).toBeNull();
    expect(parseRepoId("org/na me")).toBeNull();
    expect(parseRepoId("https://example.com/org/name")).toBeNull();
    expect(parseRepoId("org/name?x=1")).toBeNull();
  });
});

describe("parseRepoFiles", () => {
  test("lists every file but .gitattributes, with the LFS hash", () => {
    const files = parseRepoFiles(hubModel);
    expect(files.map((f) => f.path)).toEqual([
      "README.md",
      "chat_template.jinja",
      "config.json",
      "generation_config.json",
      "model-mtp.safetensors",
      "model.safetensors",
      "oq_imatrix_report.json",
      "processor_config.json",
      "tokenizer.json",
      "tokenizer_config.json",
    ]);
    const weights = files.find((f) => f.path === "model.safetensors")!;
    expect(weights.size).toBe(3677777908);
    expect(weights.sha256).toBe(
      "ca36950608cae6b6f67ab3885d6be5f043ee5901b5ca590edcd034961d587ad5",
    );
    const config = files.find((f) => f.path === "config.json")!;
    expect(config.size).toBe(33202);
    expect(config.sha256).toBeNull();
  });

  test("drops unsized files, bad hashes and escaping paths", () => {
    const files = parseRepoFiles({
      siblings: [
        { rfilename: "a.json" },
        { rfilename: "b.bin", size: 3, lfs: { sha256: "nothex" } },
        { rfilename: "../c.bin", size: 3 },
        { rfilename: "d/../e.bin", size: 3 },
        { rfilename: "sub/f.bin", lfs: { size: 7, sha256: "a".repeat(64) } },
        { rfilename: "g.bin.mlx-spy-part", size: 3 },
        { rfilename: "", size: 1 },
        { size: 1 },
      ],
    });
    expect(files).toEqual([
      { path: "b.bin", size: 3, sha256: null },
      { path: "sub/f.bin", size: 7, sha256: "a".repeat(64) },
    ]);
    expect(parseRepoFiles(null)).toEqual([]);
    expect(parseRepoFiles({ siblings: "x" })).toEqual([]);
  });
});

describe("resolveUrl and headers", () => {
  test("encodes the path segments against the commit", () => {
    expect(resolveUrl("org/name", "abc123", "sub dir/model.safetensors")).toBe(
      "https://huggingface.co/org/name/resolve/abc123/sub%20dir/model.safetensors",
    );
    expect(resolveUrl("org/name", "main", "a.json", "http://fake")).toBe(
      "http://fake/org/name/resolve/main/a.json",
    );
  });

  test("sends the bearer only with a token", () => {
    expect(hubHeaders(null)).toEqual({ "user-agent": "mlx-spy" });
    expect(hubHeaders("hf_x").authorization).toBe("Bearer hf_x");
  });
});

describe("fetchRepo", () => {
  async function withHub(
    handler: (req: Request) => Response | Promise<Response>,
    run: (hub: string) => Promise<void>,
  ) {
    const server = Bun.serve({ port: 0, fetch: handler });
    try {
      await run(`http://127.0.0.1:${server.port}`);
    } finally {
      server.stop(true);
    }
  }

  test("returns the commit and the files", async () => {
    let seen: { path: string; auth: string | null } | null = null;
    await withHub(
      (req) => {
        seen = {
          path: new URL(req.url).pathname,
          auth: req.headers.get("authorization"),
        };
        return Response.json(hubModel);
      },
      async (hub) => {
        const repo = await fetchRepo("org/name", "hf_t", undefined, hub);
        expect(repo.revision).toBe(hubModel.sha);
        expect(repo.files.length).toBe(10);
        expect(seen).toEqual({
          path: "/api/models/org/name",
          auth: "Bearer hf_t",
        });
      },
    );
  });

  test("maps the Hub's refusals", async () => {
    for (const [status, expected, text] of [
      [404, 404, "org/name not found"],
      [401, 403, "org/name is gated or private; add hf.key"],
      [403, 403, "org/name is gated or private; add hf.key"],
      [500, 502, "huggingface.co: HTTP 500"],
    ] as const) {
      await withHub(
        () => new Response("no", { status }),
        async (hub) => {
          const err = await fetchRepo("org/name", null, undefined, hub).catch(
            (e) => e,
          );
          expect(err).toBeInstanceOf(HubError);
          expect(err.status).toBe(expected);
          expect(err.message).toContain(text);
        },
      );
    }
    await withHub(
      () => Response.json({ sha: "x", siblings: [] }),
      async (hub) => {
        const err = await fetchRepo("org/name", null, undefined, hub).catch(
          (e) => e,
        );
        expect(err.status).toBe(400);
        expect(err.message).toBe("org/name has no files to download");
      },
    );
    await withHub(
      () => Response.json({ siblings: [{ rfilename: "a", size: 1 }] }),
      async (hub) => {
        const err = await fetchRepo("org/name", null, undefined, hub).catch(
          (e) => e,
        );
        expect(err.status).toBe(502);
        expect(err.message).toBe("huggingface.co: no commit for org/name");
      },
    );
  });
});
