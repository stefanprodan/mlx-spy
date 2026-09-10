// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Diagram } from "../../src/ui/chat/Diagram.tsx";
import { diagramScale } from "../../src/ui/chat/diagram.ts";

describe("diagram viewer", () => {
  test("fits wide and tall diagrams within the available viewport", () => {
    expect(
      diagramScale(
        { width: 2000, height: 500 },
        { width: 1000, height: 800 },
        null,
      ),
    ).toBe(0.5);
    expect(
      diagramScale(
        { width: 500, height: 2000 },
        { width: 350, height: 700 },
        null,
      ),
    ).toBe(0.35);
    expect(
      diagramScale(
        { width: 200, height: 100 },
        { width: 1000, height: 800 },
        null,
      ),
    ).toBe(4);
  });

  test("zoom reaches readable natural size even for very long diagrams", () => {
    const image = { width: 100, height: 20000 };
    const viewport = { width: 350, height: 700 };
    expect(diagramScale(image, viewport, null)).toBe(0.035);
    expect(diagramScale(image, viewport, 1)).toBe(1);
    expect(diagramScale(image, viewport, 4)).toBe(4);
    expect(diagramScale(image, { width: 1300, height: 800 }, 1)).toBe(1);
  });

  test("waits for the image and viewport to load", () => {
    const size = { width: 100, height: 100 };
    expect(diagramScale({ width: 0, height: 0 }, size, null)).toBe(0);
    expect(diagramScale(size, { width: 0, height: 0 }, null)).toBe(0);
  });

  test("uses an image in an accessible dialog, never inline diagram SVG", () => {
    const src = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
    const html = render(
      <Diagram src={src} title="Cache flow" onClose={() => {}} />,
    );
    expect(html).toContain(
      '<dialog class="diagram-viewer" aria-labelledby="diagram-title">',
    );
    expect(html).toContain('class="wordmark"');
    expect(html).toContain('class="mark"');
    expect(html).toContain("MLX Spy");
    expect(html).toContain(
      '<h2 id="diagram-title" title="Cache flow">Cache flow</h2>',
    );
    expect(html).toContain(`src="${src}" alt="Mermaid diagram"`);
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('aria-label="Zoom out"');
    expect(html).toContain(">Fit</button>");
    expect(html).toContain('aria-label="Close diagram"');
    expect(html).toContain('title="Close (Esc)"');
    expect(html).not.toContain("<svg></svg>");
  });
});
