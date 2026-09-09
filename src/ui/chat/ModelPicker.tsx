// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "preact/hooks";
import { models } from "../store.ts";
import { gbOf, pickModel, settings } from "./store.ts";

// the list under the model button: resident models first
export function ModelPicker({
  onClose,
  anchor,
}: {
  onClose: () => void;
  anchor: HTMLElement | null;
}) {
  const s = settings.value;
  const sorted = [...models.value].sort(
    (a, b) => Number(b.loaded) - Number(a.loaded) || a.id.localeCompare(b.id),
  );
  // a click outside or Escape closes it
  useEffect(() => {
    const onClick = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (anchor?.contains(t)) return;
      if ((t as HTMLElement).closest?.(".pop")) return;
      onClose();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchor]);
  return (
    <div class="pop" role="listbox">
      {sorted.map((m) => {
        const slash = m.id.lastIndexOf("/");
        return (
          <button
            key={m.id}
            type="button"
            role="option"
            class={m.id === s.model ? "on" : ""}
            onClick={() => {
              onClose();
              pickModel(m);
            }}
          >
            <span class={m.loaded ? "dot up" : "dot"} />
            <span class="id">
              <span class="owner">
                {slash > 0 ? m.id.slice(0, slash + 1) : ""}
              </span>
              {m.id.slice(slash + 1)}
            </span>
            <span class="size">
              {m.loaded
                ? gbOf(m.bytesResident)
                : `${gbOf(m.bytesOnDisk)} on disk`}
            </span>
          </button>
        );
      })}
      {sorted.length === 0 && <p class="evict">The engine lists no models.</p>}
    </div>
  );
}
