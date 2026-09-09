// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Tile } from "./tiles.ts";

export function Tiles({ tiles }: { tiles: Tile[] }) {
  return (
    <div class="tiles">
      {tiles.map((t) => (
        <div class="tile" key={t.key}>
          <div class="lbl">{t.label}</div>
          <div class="val">
            <span class={t.none ? "none" : undefined}>{t.value}</span>
            <span class="unit">{t.unit}</span>
          </div>
          {t.bar && (
            <div class={t.bar.off ? "bar off" : "bar"}>
              <div
                class={t.bar.level ? `fill ${t.bar.level}` : "fill"}
                style={{ width: `${t.bar.pct}%` }}
              />
            </div>
          )}
          <div class="sub">
            {t.sub.map((part, i) =>
              typeof part === "string" ? (
                part
              ) : (
                <span class="warn" key={i}>
                  {part.warn}
                </span>
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
