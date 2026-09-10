// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatSettings } from "../../chats.ts";
import { dateLine } from "../../tools/time.ts";
import { removeCurrent } from "./nav.ts";
import {
  current,
  hostTimezone,
  modelInfo,
  patch,
  settings,
  tools,
} from "./store.ts";

const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

// Preact has no defaultValue for a select (it sets a property the element
// does not have), so the option carries the selection; the form is read
// on close and selected is only re-applied when the setting itself moves
const EFFORTS = ["low", "medium", "high", "none"];

// The settings dialog: filled from the chat (or the draft) when it opens,
// written back with one PATCH when it closes with Save.
export function Settings({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const dlg = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  // two clicks, no second dialog: the first arms the button
  const [armed, setArmed] = useState(false);
  const s = settings.value;
  const list = tools.value;
  const off = s.toolsOff ?? [];
  // the runner appends today's date in the host's timezone; the empty
  // field shows what goes out in its place
  const tz = hostTimezone.value;
  const placeholder = tz
    ? dateLine(Date.now(), tz)
    : "Empty: the model's own default";
  useEffect(() => {
    const d = dlg.current;
    if (!d || !open) return;
    setArmed(false);
    d.returnValue = "";
    d.showModal();
  }, [open]);
  const read = (): Partial<ChatSettings> => {
    const f = form.current!;
    const v = (name: string) =>
      (f.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement)
        .value;
    return {
      systemPrompt: v("systemPrompt"),
      reasoningEffort: v("reasoningEffort") || null,
      reasoningHistory: v("reasoningHistory") === "on",
      temperature: numOrNull(v("temperature")),
      topP: numOrNull(v("topP")),
      maxTokens: numOrNull(v("maxTokens")),
      search: v("search") === "firecrawl" ? "firecrawl" : "exa",
      toolsOff: [...f.querySelectorAll<HTMLInputElement>(".tools input")]
        .filter((cb) => !cb.checked)
        .map((cb) => cb.value),
    };
  };
  // a model list with capabilities that leave out tool use is a hint, not
  // a gate: a plain /v1/models has no capabilities at all
  const info = s.model ? modelInfo(s.provider, s.model) : null;
  const doubtful =
    info !== null &&
    info.capabilities.length > 0 &&
    !info.capabilities.includes("tool_use");
  return (
    <dialog
      class="settings"
      ref={dlg}
      onClose={() => {
        const ok = dlg.current?.returnValue === "ok";
        onClose();
        if (ok) void patch(read());
      }}
    >
      {open && (
        <form method="dialog" ref={form}>
          <h3>Chat settings</h3>
          <label>
            System prompt
            <textarea
              name="systemPrompt"
              rows={4}
              placeholder={placeholder}
              defaultValue={s.systemPrompt}
            />
          </label>
          <div class="fields">
            <label>
              Reasoning effort
              <select name="reasoningEffort">
                <option value="" selected={s.reasoningEffort === null}>
                  engine default
                </option>
                {EFFORTS.map((e) => (
                  <option key={e} value={e} selected={s.reasoningEffort === e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Past reasoning
              <select name="reasoningHistory">
                <option value="on" selected={s.reasoningHistory}>
                  sent back
                </option>
                <option value="off" selected={!s.reasoningHistory}>
                  not sent back
                </option>
              </select>
            </label>
            <label>
              Temperature
              <input
                name="temperature"
                type="number"
                min={0}
                max={2}
                step={0.05}
                placeholder="engine"
                defaultValue={
                  s.temperature === null ? "" : String(s.temperature)
                }
              />
            </label>
            <label>
              Top p
              <input
                name="topP"
                type="number"
                min={0}
                max={1}
                step={0.01}
                placeholder="engine"
                defaultValue={s.topP === null ? "" : String(s.topP)}
              />
            </label>
            <label>
              Max tokens
              <input
                name="maxTokens"
                type="number"
                min={1}
                step={1}
                placeholder="auto"
                defaultValue={s.maxTokens === null ? "" : String(s.maxTokens)}
              />
            </label>
            <label>
              Search
              <select name="search">
                <option value="exa" selected={s.search !== "firecrawl"}>
                  Exa
                </option>
                <option value="firecrawl" selected={s.search === "firecrawl"}>
                  Firecrawl
                </option>
              </select>
            </label>
          </div>
          <fieldset class="tools" aria-label="Tools" hidden={list.length === 0}>
            <legend>Tools</legend>
            {list.map((t) => (
              <label key={t.name} title={t.description}>
                <input
                  type="checkbox"
                  value={t.name}
                  defaultChecked={!off.includes(t.name)}
                />
                <b>{t.name}</b>
              </label>
            ))}
          </fieldset>
          <p class="hint" hidden={!doubtful || list.length === 0}>
            {s.provider === "openrouter"
              ? "OpenRouter does not list tool use for this model; calls may not work."
              : "The engine does not list tool use for this model; calls may not work."}
          </p>
          <p class="hint">
            Empty fields use the engine's defaults. Changes apply to the next
            message.
          </p>
          <div class="row">
            <button
              type="button"
              class="btn danger"
              hidden={current.value === null}
              onClick={() => {
                if (!armed) {
                  setArmed(true);
                  return;
                }
                dlg.current?.close("delete");
                void removeCurrent();
              }}
            >
              {armed ? "Confirm delete" : "Delete chat"}
            </button>
            <span class="grow" />
            <button type="submit" value="cancel" class="btn">
              Cancel
            </button>
            <button type="submit" value="ok" class="btn primary">
              Save
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
