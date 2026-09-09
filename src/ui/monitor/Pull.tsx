// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Model downloads: the dialog that asks for a Hub repo, the rows the models
// table shows while a pull is queued, running, stopped or waiting to be
// listed, and the calls behind their buttons. The server owns the pull;
// the rows follow the /ws pull messages through the store.

import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { Pull } from "../../pulls.ts";
import { Trash } from "../icons.tsx";
import { confirm } from "../shell/Confirm.tsx";
import { applyPull, pulls, snapshot } from "../store.ts";
import { pullDot, pullMeta, pullPct, pullState } from "./pull.ts";

const ICON = {
  play: "M5 3l9 5-9 5z",
  pause: "M4 3h3v10H4zM9 3h3v10H9z",
};

const open = signal(false);
const sending = signal(false);
const error = signal("");
// the last pull that failed to start or to be controlled from this tab,
// for the line under the table
export const pullError = signal<{
  t: number;
  repo: string;
  text: string;
} | null>(null);

export function openPull() {
  error.value = "";
  open.value = true;
}

async function call(path: string, method: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json()) as Pull | { ok: true } | { error: string };
  if (!res.ok) {
    throw new Error((data as { error: string }).error ?? `HTTP ${res.status}`);
  }
  return data;
}

async function start(repo: string): Promise<boolean> {
  sending.value = true;
  error.value = "";
  try {
    applyPull((await call("/api/pulls", "POST", { repo })) as Pull);
    return true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    sending.value = false;
  }
}

async function control(p: Pull, what: "cancel" | "retry" | "remove") {
  try {
    if (what === "cancel") {
      applyPull((await call(`/api/pulls/${p.id}/cancel`, "POST", {})) as Pull);
    } else if (what === "retry") {
      applyPull((await call("/api/pulls", "POST", { repo: p.repo })) as Pull);
    } else {
      // the files go too, whatever the state: a delete is a delete
      const a = await confirm(
        ["Are you sure you want to delete ", { code: p.repo }, "?"],
        "Delete",
      );
      if (!a.ok) return;
      await call(`/api/pulls/${p.id}`, "DELETE");
      pulls.value = pulls.value.filter((x) => x.id !== p.id);
    }
  } catch (err) {
    pullError.value = {
      t: Date.now(),
      repo: p.repo,
      text: err instanceof Error ? err.message : String(err),
    };
  }
}

export function PullDialog() {
  const dlg = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const isOpen = open.value;
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (isOpen && !d.open) {
      if (input.current) input.current.value = "";
      d.showModal();
    } else if (!isOpen && d.open) {
      d.close();
    }
  }, [isOpen]);
  const submit = async (e: Event) => {
    e.preventDefault();
    const repo = input.current?.value.trim() ?? "";
    if (repo === "") return;
    if (await start(repo)) open.value = false;
  };
  return (
    <dialog
      id="pull"
      ref={dlg}
      onClose={() => {
        open.value = false;
      }}
    >
      <form onSubmit={(e) => void submit(e)}>
        <p>Download a model from the Hugging Face Hub</p>
        <label class="field">
          <span class="lbl">Repository</span>
          <input
            ref={input}
            id="pull-repo"
            name="repo"
            type="text"
            placeholder="owner/name or huggingface.co URL"
            autocomplete="off"
            spellcheck={false}
            required
          />
        </label>
        <p class="note">
          local storage:{" "}
          <code>{snapshot.value?.modelDir ?? "the model directory"}</code>
        </p>
        <p class="err" hidden={error.value === ""}>
          {error.value}
        </p>
        <div class="row">
          <button
            type="button"
            class="btn"
            onClick={() => {
              open.value = false;
            }}
          >
            Cancel
          </button>
          <button type="submit" class="btn primary" disabled={sending.value}>
            Download
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Icon({
  label,
  glyph,
  cls = "",
  onClick,
}: {
  label: string;
  glyph: string;
  cls?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      class={`ibtn ${cls}`.trim()}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d={glyph} />
      </svg>
    </button>
  );
}

// One row per pull, shaped like a model row: the dot, the id, the bytes
// and speed, the state, the buttons; a bar under the id while it runs.
export function PullRow({ p }: { p: Pull }) {
  const slash = p.repo.lastIndexOf("/");
  const active = p.status === "queued" || p.status === "running";
  return (
    <tr class={`pull ${p.status}`} title={p.error ?? undefined}>
      <td class="name" title={p.file ? `${p.repo}: ${p.file}` : p.repo}>
        <div>
          <span class={`dot ${pullDot(p)}`} />
          <span class="owner">{p.repo.slice(0, slash + 1)}</span>
          <a
            class="model"
            href={`https://huggingface.co/${p.repo}`}
            target="_blank"
            rel="noopener"
          >
            {p.repo.slice(slash + 1)}
          </a>
        </div>
        <div class="bar" hidden={p.status !== "running"}>
          <span class="fill" style={{ width: `${pullPct(p)}%` }} />
        </div>
      </td>
      <td class="meta">{pullMeta(p)}</td>
      <td class={`state ${p.status}`}>{pullState(p)}</td>
      <td class="act">
        <button
          type="button"
          class="ibtn trash danger"
          title="Delete"
          aria-label="Delete"
          onClick={() => void control(p, "remove")}
        >
          <Trash />
        </button>
        {active ? (
          <Icon
            label="Pause"
            glyph={ICON.pause}
            onClick={() => void control(p, "cancel")}
          />
        ) : (
          p.status !== "done" && (
            <Icon
              label="Resume"
              glyph={ICON.play}
              onClick={() => void control(p, "retry")}
            />
          )
        )}
      </td>
    </tr>
  );
}
