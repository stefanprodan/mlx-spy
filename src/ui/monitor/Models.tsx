// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One row per model: a state dot and the id split at its last slash, the
// size and context in dim text, the engine's state word, icon buttons.
// Activity is engine-wide (the engine does not say which model is busy)
// and lives in the section head, see Monitor.tsx.

import type { ActionName } from "../../actions.ts";
import type { Capability, ModelInfo } from "../../engine/types.ts";
import { gb } from "../format.ts";
import { busy, type Snapshot } from "../store.ts";
import { runAction } from "./actions.ts";

const ICON = {
  play: "M5 3l9 5-9 5z",
  stop: "M4 4h8v8H4z",
  star: "M8 1.6l2 4.1 4.5.6-3.3 3.2.8 4.5L8 11.9l-4 2.1.8-4.5L1.5 6.3 6 5.7z",
};

function dotFor(state: string) {
  switch (state) {
    case "ready":
      return "ready";
    case "loading":
      return "loading";
    case "evicting":
      return "evicting";
    case "error":
    case "failed":
      return "error";
    default:
      return "";
  }
}

function IconButton({
  label,
  glyph,
  action,
  model,
  cls = "",
}: {
  label: string;
  glyph: string;
  action: ActionName;
  model: string;
  cls?: string;
}) {
  return (
    <button
      type="button"
      class={`ibtn ${cls}`.trim()}
      title={label}
      aria-label={label}
      disabled={busy.value !== null}
      onClick={() => void runAction(action, model)}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d={glyph} />
      </svg>
    </button>
  );
}

// Icon buttons with the action as tooltip and label: the favorite star on
// every model, then load for an unloaded one or unload for a resident one.
function Buttons({
  m,
  can,
}: {
  m: ModelInfo;
  can: (c: Capability) => boolean;
}) {
  return (
    <td class="act">
      {m.favorite ? (
        <IconButton
          label="Daily driver"
          glyph={ICON.star}
          action="favorite"
          model={m.id}
          cls="on"
        />
      ) : (
        <IconButton
          label="Mark as daily driver"
          glyph={ICON.star}
          action="favorite"
          model={m.id}
        />
      )}
      {m.loaded
        ? can("unload") && (
            <IconButton
              label="Unload"
              glyph={ICON.stop}
              action="unload"
              model={m.id}
              cls="danger"
            />
          )
        : can("load") && (
            <IconButton
              label="Load"
              glyph={ICON.play}
              action="load"
              model={m.id}
            />
          )}
    </td>
  );
}

export function Models({ snap }: { snap: Snapshot | null }) {
  const models = snap?.models ?? [];
  const can = (c: Capability) => snap?.engine.capabilities.includes(c) ?? false;
  // the list is empty while the engine is unreachable (the sampler drops
  // it) or when it really lists nothing; one sentence either way
  const none =
    snap?.sample && !snap.sample.engineUp
      ? "Engine unreachable."
      : "No models found.";
  return (
    <section class="card models">
      <table id="models">
        <tbody>
          {models.map((m) => {
            const slash = m.id.lastIndexOf("/");
            const facts = [
              `${gb(m.loaded ? m.bytesResident : m.bytesOnDisk)} GB`,
            ];
            if (m.contextLength != null) {
              facts.push(`${Math.round(m.contextLength / 1024)}K ctx`);
            }
            return (
              <tr key={m.id} class={m.loaded ? "ready" : undefined}>
                <td class="name" title={m.id}>
                  <div>
                    <span class={`dot ${dotFor(m.state)}`} />
                    <span class="owner">
                      {slash > 0 ? `${m.id.slice(0, slash)}/` : ""}
                    </span>
                    {/* model ids are Hugging Face repo ids */}
                    <a
                      class="model"
                      href={`https://huggingface.co/${m.id}`}
                      target="_blank"
                      rel="noopener"
                    >
                      {m.id.slice(slash + 1)}
                    </a>
                  </div>
                </td>
                <td class="meta">{facts.join(" · ")}</td>
                <td class={`state ${m.state}`}>{m.state}</td>
                <Buttons m={m} can={can} />
              </tr>
            );
          })}
        </tbody>
      </table>
      <p class="blank" hidden={models.length > 0}>
        {none}
      </p>
    </section>
  );
}
