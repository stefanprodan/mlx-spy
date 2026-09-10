// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "preact/hooks";
import { Caret, Cloud, Gear, Lines } from "../icons.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { current, modelInfo, patch, settings, short } from "./store.ts";

// the title is edited in place; Enter saves, Escape restores
function Title() {
  const cur = current.value;
  const [editing, setEditing] = useState(false);
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      inp.current?.focus();
      inp.current?.select();
    }
  }, [editing]);
  const title = cur?.title || "New chat";
  if (!editing || !cur) {
    return (
      <button
        type="button"
        class="title"
        title="Rename"
        onClick={() => {
          if (cur) setEditing(true);
        }}
      >
        {title}
      </button>
    );
  }
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    setEditing(false);
    const next = inp.current?.value.trim() ?? "";
    if (save && next && next !== cur.title) void patch({ title: next });
  };
  return (
    <input
      ref={inp}
      class="title"
      defaultValue={cur.title}
      maxLength={120}
      aria-label="Chat title"
      onKeyDown={(ev) => {
        if (ev.key === "Enter") finish(true);
        else if (ev.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

export function Header({
  onList,
  onSettings,
}: {
  onList: () => void;
  onSettings: () => void;
}) {
  const s = settings.value;
  const cur = current.value;
  const info = s.model ? modelInfo(s.provider, s.model) : null;
  const remote = s.provider === "openrouter";
  const [pop, setPop] = useState(false);
  const modelBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    document.title = cur?.title ? `${cur.title} · mlx-spy` : "mlx-spy · chat";
  }, [cur?.title]);
  const modelTitle = info
    ? remote
      ? `${s.model} on OpenRouter`
      : info.loaded
        ? `${s.model}, loaded`
        : `${s.model}, not loaded`
    : s.model
      ? remote
        ? `${s.model} is not in the OpenRouter list anymore`
        : `${s.model} is not on the engine anymore`
      : "";
  return (
    <div class="chead">
      <button
        type="button"
        class="btn icon listbtn"
        aria-label="Chats"
        onClick={onList}
      >
        <Lines />
      </button>
      <Title />
      <span class="grow" />
      <div class="ctl">
        <button
          ref={modelBtn}
          type="button"
          class={
            s.model !== "" && info === null ? "btn model missing" : "btn model"
          }
          aria-haspopup="listbox"
          title={modelTitle}
          onClick={() => setPop((p) => !p)}
        >
          {remote ? <Cloud /> : <i class={info?.loaded ? "dot up" : "dot"} />}
          <span class="name">{s.model ? short(s.model) : "pick a model"}</span>
          <Caret />
        </button>
        <fieldset class="seg" aria-label="Thinking">
          <button
            type="button"
            class={s.thinking ? "on" : ""}
            onClick={() => void patch({ thinking: true })}
          >
            <span class="sl">Think </span>on
          </button>
          <button
            type="button"
            class={s.thinking ? "" : "on"}
            onClick={() => void patch({ thinking: false })}
          >
            <span class="sl">Think </span>off
          </button>
        </fieldset>
        <button
          type="button"
          class="btn icon"
          aria-label="Chat settings"
          onClick={onSettings}
        >
          <Gear />
        </button>
      </div>
      {pop && (
        <ModelPicker anchor={modelBtn.current} onClose={() => setPop(false)} />
      )}
    </div>
  );
}
