// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "preact/hooks";
import { orderModels } from "../format.ts";
import { Cloud } from "../icons.tsx";
import { models, remoteModels } from "../store.ts";
import { openConfig } from "./nav.ts";
import { gbOf, pickModel, remoteInfo, runs, settings } from "./store.ts";

// a price per million tokens, in and out: "$0.30 / $1.20", or "free"
export function priceLabel(
  promptPrice: number | null,
  completionPrice: number | null,
): string {
  if (promptPrice === null || completionPrice === null) return "";
  if (promptPrice === 0 && completionPrice === 0) return "free";
  const usd = (v: number) => `$${v < 10 ? v.toFixed(2) : v.toFixed(0)}`;
  return `${usd(promptPrice)} / ${usd(completionPrice)}`;
}

const splitId = (id: string) => {
  const slash = id.lastIndexOf("/");
  return [slash > 0 ? id.slice(0, slash + 1) : "", id.slice(slash + 1)];
};

// the list under the model button: the engine's models, resident first,
// then the hosted ones added on the Settings page
export function ModelPicker({
  onClose,
  anchor,
}: {
  onClose: () => void;
  anchor: HTMLElement | null;
}) {
  const s = settings.value;
  const sorted = orderModels(models.value);
  const remote = remoteModels.value;
  // OpenRouter is configured when the server gives it a cap; a key with
  // nothing added shows one line that opens the Settings page
  const hosted = (runs.value?.limits.openrouter ?? 0) > 0;
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
        const [owner, name] = splitId(m.id);
        return (
          <button
            key={m.id}
            type="button"
            role="option"
            class={s.provider === "mlxserve" && m.id === s.model ? "on" : ""}
            onClick={() => {
              onClose();
              pickModel("mlxserve", m);
            }}
          >
            <span class={m.loaded ? "dot up" : "dot"} />
            <span class="id">
              <span class="owner">{owner}</span>
              {name}
            </span>
            <span class="size">
              {gbOf(m.loaded ? m.bytesResident : m.bytesOnDisk)}
            </span>
          </button>
        );
      })}
      {sorted.length === 0 && <p class="evict">The engine lists no models.</p>}
      {hosted && <h4>OpenRouter</h4>}
      {hosted &&
        remote.map((m) => {
          const [owner, name] = splitId(m.id);
          return (
            <button
              key={`or-${m.id}`}
              type="button"
              role="option"
              class={
                s.provider === "openrouter" && m.id === s.model
                  ? "on remote"
                  : "remote"
              }
              onClick={() => {
                onClose();
                pickModel("openrouter", remoteInfo(m));
              }}
            >
              <Cloud />
              <span class="id" title={m.name}>
                <span class="owner">{owner}</span>
                {name}
              </span>
              <span class="size">
                {priceLabel(m.promptPrice, m.completionPrice)}
              </span>
            </button>
          );
        })}
      {hosted && remote.length === 0 && (
        <button
          type="button"
          class="add"
          onClick={() => {
            onClose();
            openConfig(true);
          }}
        >
          Add models in Settings
        </button>
      )}
    </div>
  );
}
