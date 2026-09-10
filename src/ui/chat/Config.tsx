// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Settings page of the chat, in place of the conversation: the hosted
// models the picker offers. OpenRouter's section shows when the server
// found a key; a pasted id is checked against the live catalog before it
// can be added, and every open of the page refreshes the saved rows'
// prices from it. The server owns the list; the socket's `remoteModels`
// message carries every change to every tab.

import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { RemoteModel } from "../../config.ts";
import type { CatalogModel } from "../../engine/openrouter.ts";
import { api } from "../api.ts";
import { when } from "../format.ts";
import { Cloud, Lines } from "../icons.tsx";
import { remoteModels } from "../store.ts";
import { priceLabel } from "./ModelPicker.tsx";
import { closeConfig } from "./nav.ts";
import { k, n } from "./store.ts";

type ConfigAnswer = {
  openrouter: { enabled: boolean; limit: number; models: RemoteModel[] };
};

// null until the first answer; the page keeps its layout meanwhile
export const enabled = signal<boolean | null>(null);
export const limit = signal(0);
// the last refresh: when it ran, or why it failed
export const refreshed = signal<{ at: number; error: string | null } | null>(
  null,
);
// the id being checked and what the catalog said about it
export const draftId = signal("");
export const checked = signal<CatalogModel | null>(null);
export const checkError = signal("");
export const busy = signal(false);
// the id whose Remove was clicked once; the second click removes
export const armed = signal<string | null>(null);

const text = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export async function load() {
  try {
    const r = await api<ConfigAnswer>("/api/config");
    enabled.value = r.openrouter.enabled;
    limit.value = r.openrouter.limit;
    remoteModels.value = r.openrouter.models;
  } catch (err) {
    // not "no key": the page could not be read at all
    enabled.value = null;
    refreshed.value = { at: Date.now(), error: text(err) };
    return;
  }
  if (enabled.value) await refresh();
}

export async function refresh() {
  try {
    const r = await api<{ models: RemoteModel[]; checkedAt: number }>(
      "/api/config/openrouter/refresh",
      "POST",
      {},
    );
    remoteModels.value = r.models;
    refreshed.value = { at: r.checkedAt, error: null };
  } catch (err) {
    refreshed.value = { at: Date.now(), error: text(err) };
  }
}

// the check in flight; a newer id or edit outdates it
let checking = 0;

export async function check(id: string) {
  const trimmed = id.trim();
  checked.value = null;
  checkError.value = "";
  if (trimmed === "") return;
  const mine = ++checking;
  busy.value = true;
  try {
    const r = await api<{ model: CatalogModel | null }>(
      "/api/config/openrouter/check",
      "POST",
      { id: trimmed },
    );
    // an answer for an older id is dropped
    if (mine !== checking) return;
    checked.value = r.model;
    if (!r.model) {
      checkError.value = `${trimmed} is not in the OpenRouter catalog`;
    }
  } catch (err) {
    if (mine === checking) checkError.value = text(err);
  } finally {
    if (mine === checking) busy.value = false;
  }
}

export async function add(id: string) {
  busy.value = true;
  try {
    const row = await api<RemoteModel>(
      "/api/config/openrouter/models",
      "POST",
      { id },
    );
    // the socket carries the list too; this tab need not wait for it
    if (!remoteModels.value.some((m) => m.id === row.id)) {
      remoteModels.value = [...remoteModels.value, row];
    }
    draftId.value = "";
    checked.value = null;
    checkError.value = "";
  } catch (err) {
    checkError.value = text(err);
  } finally {
    busy.value = false;
  }
}

export async function remove(id: string) {
  armed.value = null;
  try {
    await api(
      `/api/config/openrouter/models/${encodeURIComponent(id)}`,
      "DELETE",
    );
    remoteModels.value = remoteModels.value.filter((m) => m.id !== id);
  } catch (err) {
    checkError.value = text(err);
  }
}

const ctx = (v: number | null) =>
  v === null ? "" : `${v >= 1_000_000 ? `${v / 1_000_000}M` : k(v)} ctx`;
const marks = (m: { tools: boolean; reasoning: boolean }) =>
  [m.tools ? "tools" : "", m.reasoning ? "reasoning" : ""]
    .filter(Boolean)
    .join(" · ");

function Preview({ m }: { m: CatalogModel }) {
  return (
    <div class="preview">
      <span class="id" title={m.name}>
        <Cloud />
        {m.id}
      </span>
      <span class="facts">
        {[
          priceLabel(m.promptPrice, m.completionPrice),
          ctx(m.contextLength),
          marks(m),
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      <button
        type="button"
        class="btn primary"
        disabled={busy.value}
        onClick={() => void add(m.id)}
      >
        Add
      </button>
    </div>
  );
}

function Rows() {
  const rows = remoteModels.value;
  return (
    <table class="remote">
      <thead>
        <tr>
          <th>Model</th>
          <th>In / out per 1M</th>
          <th>Window</th>
          <th>Supports</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.id} class={m.missing ? "missing" : undefined}>
            <td class="name" title={m.name}>
              <Cloud />
              {m.id}
            </td>
            <td class="price">
              {m.missing
                ? "not in catalog"
                : priceLabel(m.promptPrice, m.completionPrice)}
            </td>
            <td class="ctx">{m.missing ? "" : ctx(m.contextLength)}</td>
            <td class="caps">{marks(m)}</td>
            <td class="act">
              <button
                type="button"
                class={armed.value === m.id ? "btn danger" : "btn"}
                onClick={() => {
                  if (armed.value === m.id) void remove(m.id);
                  else armed.value = m.id;
                }}
              >
                {armed.value === m.id ? "Confirm" : "Remove"}
              </button>
            </td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr class="blank">
            <td colSpan={5}>No models yet. Paste an id above.</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export function Config({ onList }: { onList: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    document.title = "mlx-spy · settings";
    void load();
    return () => {
      armed.value = null;
      checked.value = null;
      checkError.value = "";
    };
  }, []);
  const on = enabled.value;
  const last = refreshed.value;
  const status =
    on === null
      ? last?.error
        ? `Settings could not load: ${last.error}`
        : ""
      : last === null
        ? "checking prices"
        : last.error
          ? `OpenRouter unreachable: ${last.error}`
          : `prices as of ${when(last.at, Date.now())}`;
  return (
    <section class="conv config">
      <div class="chead">
        <button
          type="button"
          class="btn icon listbtn"
          aria-label="Chats"
          onClick={onList}
        >
          <Lines />
        </button>
        <span class="title">Settings</span>
        <span class="grow" />
        <button type="button" class="btn" onClick={closeConfig}>
          Done
        </button>
      </div>
      <div class="scroll">
        <div class="cfg">
          <h3>
            OpenRouter
            <span class="status" title={status}>
              {status}
            </span>
          </h3>
          {on === false && (
            <p class="none">
              No OpenRouter key. Put it in{" "}
              <code>../secrets/openrouter.key</code> next to the binary (
              <code>.preview/secrets/</code> from source) and restart.
            </p>
          )}
          {on && (
            <>
              <p class="hint">
                Models added here appear in the picker under OpenRouter, up to{" "}
                {n(limit.value)} chats at once. Prices are USD per million
                tokens, refreshed each time this page opens. A chat on one of
                them leaves this host.
              </p>
              <form
                class="addrow"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  void check(draftId.value);
                }}
              >
                <input
                  ref={input}
                  name="id"
                  value={draftId.value}
                  placeholder="owner/model:free"
                  aria-label="OpenRouter model id"
                  spellcheck={false}
                  onInput={(ev) => {
                    draftId.value = ev.currentTarget.value;
                    checking++;
                    busy.value = false;
                    checked.value = null;
                    checkError.value = "";
                  }}
                />
                <button
                  type="submit"
                  class="btn"
                  disabled={busy.value || draftId.value.trim() === ""}
                >
                  Check
                </button>
              </form>
              <p class="err" hidden={checkError.value === ""}>
                {checkError.value}
              </p>
              {checked.value && <Preview m={checked.value} />}
              <Rows />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
