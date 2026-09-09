import { describe, expect, test } from "bun:test";
import { highlight, MAX_BYTES } from "../src/highlight.ts";

describe("highlight", () => {
  test("escapes every token and keeps the text intact", () => {
    const out = highlight('let s = "<a>&\'b"; // c', "javascript");
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/<(?!\/?span)/);
    expect(out?.replace(/<[^>]+>/g, "")).toBe(
      "let s = &quot;&lt;a&gt;&amp;&#x27;b&quot;; // c",
    );
  });

  test("aliases models write resolve", () => {
    for (const lang of [
      "ts",
      "tsx",
      "js",
      "py",
      "sh",
      "zsh",
      "console",
      "yml",
      "jsonc",
      "toml",
      "proto",
      "svg",
      "golang",
      "rs",
      "c++",
      "cs",
      "rb",
      "kt",
      "docker",
      "python3",
      "objective-c",
    ]) {
      expect(highlight("x", lang), lang).not.toBeNull();
    }
  });

  test("an unknown language gets null, and so does markdown", () => {
    expect(highlight("x", "nope")).toBeNull();
    expect(highlight("x", "")).toBeNull();
    expect(highlight("[x](y)", "markdown")).toBeNull();
  });

  test("a block over the size cap stays plain", () => {
    const line = "let a = 1;\n";
    const small = line.repeat(Math.floor(MAX_BYTES / line.length));
    expect(highlight(small, "js")).not.toBeNull();
    expect(
      highlight(line.repeat(MAX_BYTES / line.length + 1), "js"),
    ).toBeNull();
  });

  test("illegal syntax still renders", () => {
    expect(highlight("}}} ))) ''' \"", "json")).not.toBeNull();
    expect(highlight("<<<< >>>>", "xml")).not.toBeNull();
  });

  test("a big block is fast enough for the streaming render", () => {
    const text = "const a = { b: [1, 2, 3], c: 'x' }; // y\n".repeat(700);
    expect(text.length).toBeLessThan(MAX_BYTES);
    const t = performance.now();
    highlight(text, "ts");
    expect(performance.now() - t).toBeLessThan(500);
  });

  test("hostile input at the size cap stays under a frame or so", () => {
    const cases: [string, string][] = [
      ["typescript", "/".repeat(MAX_BYTES)],
      ["javascript", `\`${"${".repeat(8000)}x${"}".repeat(8000)}\``],
      ["xml", `${"<a ".repeat(10000)}>`],
      ["ruby", "/".repeat(MAX_BYTES)],
      ["css", "{".repeat(MAX_BYTES)],
      ["bash", "$(".repeat(MAX_BYTES / 2)],
      ["python", '"""'.repeat(MAX_BYTES / 3)],
      ["sql", "'".repeat(MAX_BYTES)],
      ["yaml", "- ".repeat(MAX_BYTES / 2)],
      ["diff", "@@ ".repeat(MAX_BYTES / 3)],
    ];
    for (const [lang, text] of cases) {
      const t = performance.now();
      highlight(text, lang);
      expect(performance.now() - t, lang).toBeLessThan(300);
    }
  });
});
