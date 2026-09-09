import { describe, expect, test } from "bun:test";
import {
  edgeCount,
  MAX_BYTES,
  MAX_EDGES,
  MAX_SVG_BYTES,
  renderDiagram,
  renderDiagramSvg,
} from "../src/diagram.ts";

const FLOW = "graph TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[End]";

describe("renderDiagram", () => {
  test("a flowchart becomes an image with an inline SVG", () => {
    const html = renderDiagram(FLOW);
    expect(html).toStartWith(
      '<img class="diagram" alt="diagram" src="data:image/svg+xml;base64,',
    );
    const svg = Buffer.from(
      html?.slice(html.indexOf("base64,") + 7, -2) ?? "",
      "base64",
    ).toString("utf8");
    expect(svg).toStartWith("<svg");
    expect(svg).toContain("Decision");
  });

  test("the image points nowhere: no font import, url, script or href", () => {
    const svg = renderDiagramSvg(FLOW) ?? "";
    expect(svg).not.toContain("googleapis");
    expect(svg).not.toMatch(/@import|url\((?!#)|<script|href=/i);
  });

  test("labels are text, never markup", () => {
    const svg =
      renderDiagramSvg(
        'graph LR\n  A["<img src=x onerror=alert(1)>"] --> B[a & b "q"]',
      ) ?? "";
    expect(svg).not.toContain("<img");
    expect(svg).toContain("&lt;img");
    expect(svg).toContain("a &amp; b");
  });

  test("style directives are dropped, escapes and comments included", () => {
    const styled = (fill: string) =>
      `graph TD\n  A[x] --> B[y]\n  style A fill:${fill}\n  classDef c fill:${fill}\n  class B c\n  linkStyle 0 stroke:${fill}`;
    for (const fill of [
      "url(https://example.invalid/a)",
      "u\\72l(https://example.invalid/a)",
      "u/**/rl(https://example.invalid/a)",
      "#f9f",
    ]) {
      const svg = renderDiagramSvg(styled(fill));
      expect(svg, fill).toContain("<svg");
      expect(svg, fill).not.toContain("example.invalid");
      expect(svg, fill).not.toContain("f9f");
    }
  });

  test("sequence, state and class diagrams draw too", () => {
    expect(
      renderDiagramSvg("sequenceDiagram\n  A->>B: hi\n  B-->>A: hello"),
    ).toContain("<svg");
    expect(
      renderDiagramSvg("stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy"),
    ).toContain("<svg");
    expect(
      renderDiagramSvg("classDiagram\n  class A {\n    +go()\n  }\n  A <|-- B"),
    ).toContain("<svg");
  });

  test("what the library cannot draw is null", () => {
    expect(renderDiagram("pie title x\n  a: 1")).toBeNull();
    expect(renderDiagram("gantt\n  title x")).toBeNull();
    expect(renderDiagram("not a diagram")).toBeNull();
    expect(renderDiagram("")).toBeNull();
  });

  test("a source over the cap is null", () => {
    const line = "  A --> B\n";
    const big = `graph TD\n${line.repeat(MAX_BYTES / line.length + 1)}`;
    expect(renderDiagram(big)).toBeNull();
  });

  test("edges are counted with their fan-out", () => {
    expect(
      edgeCount("graph TD\n  A --> B\n  B --- C\n  C -.-> D\n  D ==> E"),
    ).toBe(4);
    expect(edgeCount("graph LR\n  A & B --> C & D")).toBe(4);
    expect(edgeCount("graph LR\n  A & B & C --> D & E --> F")).toBe(8);
    expect(edgeCount("graph LR\n  A -> B\n  C --o D\n  E --x F")).toBe(3);
    expect(edgeCount("classDiagram\n  A <|-- B\n  C ..> D")).toBe(2);
    expect(edgeCount("sequenceDiagram\n  A->>B: hi\n  B-->>A: yo")).toBe(2);
  });

  test("a dense graph under the byte cap but over the edge cap is null", () => {
    let src = "graph TD\n";
    for (let i = 0; i < 24; i++)
      for (let j = 0; j < 24; j++) if (i !== j) src += `  n${i} --> n${j}\n`;
    expect(src.length).toBeLessThan(MAX_BYTES);
    expect(edgeCount(src)).toBeGreaterThan(MAX_EDGES);
    const t = performance.now();
    expect(renderDiagramSvg(src)).toBeNull();
    expect(performance.now() - t).toBeLessThan(50);
  });

  test("a fan-out over the edge cap is null at once", () => {
    const names = (p: string) =>
      Array.from({ length: 26 }, (_, i) => `${p}${i}`).join(" & ");
    const src = `graph TD\n  ${names("a")} --> ${names("b")}`;
    expect(edgeCount(src)).toBe(676);
    const t = performance.now();
    expect(renderDiagramSvg(src)).toBeNull();
    expect(performance.now() - t).toBeLessThan(50);
  });

  test("the byte cap counts UTF-8 bytes", () => {
    const line = "  A[ééééééééé] --> B\n";
    const src = `graph TD\n${line.repeat((MAX_BYTES * 0.9) / line.length)}`;
    expect(src.length).toBeLessThan(MAX_BYTES);
    expect(Buffer.byteLength(src)).toBeGreaterThan(MAX_BYTES);
    expect(renderDiagramSvg(src)).toBeNull();
  });

  test("an SVG over its cap is null", () => {
    const chart = (n: number) => {
      const xs = Array.from({ length: n }, (_, i) => i).join(", ");
      return `xychart-beta\n  x-axis [${xs}]\n  line [${xs}]`;
    };
    const small = renderDiagramSvg(chart(300));
    expect(small?.length).toBeLessThanOrEqual(MAX_SVG_BYTES);
    expect(renderDiagramSvg(chart(500))).toBeNull();
  });

  test("a second render of the same source is a cache hit", () => {
    const src = "graph LR\n  X --> Y --> Z";
    renderDiagramSvg(src);
    const t = performance.now();
    renderDiagramSvg(src);
    expect(performance.now() - t).toBeLessThan(5);
  });

  test("a dense graph at the cap renders in bounded time", () => {
    const n = 150;
    const src = `graph TD\n${Array.from(
      { length: n },
      (_, i) => `  n${i}[Node ${i}] --> n${(i * 7 + 1) % n}`,
    ).join("\n")}`;
    expect(src.length).toBeLessThan(MAX_BYTES);
    const t = performance.now();
    expect(renderDiagramSvg(src)).toContain("<svg");
    expect(performance.now() - t).toBeLessThan(1500);
  });
});
