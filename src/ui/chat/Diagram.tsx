// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { useLayoutEffect, useRef } from "preact/hooks";
import { Close, Mark, Minus, Plus } from "../icons.tsx";
import {
  diagramScale,
  MAX_ZOOM,
  MIN_ZOOM,
  type Size,
  ZOOM_STEP,
} from "./diagram.ts";

export function Diagram({
  src,
  title,
  onClose,
}: {
  src: string;
  title: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLElement>(null);
  const image = useSignal<Size>({ width: 0, height: 0 });
  const room = useSignal<Size>({ width: 0, height: 0 });
  const zoom = useSignal<number | null>(null);
  const failed = useSignal(false);
  useLayoutEffect(() => {
    const d = dialog.current;
    const v = viewport.current;
    if (!d || !v) return;
    d.showModal();
    const resize = () => {
      room.value = { width: v.clientWidth - 32, height: v.clientHeight - 32 };
    };
    const observer = new ResizeObserver(resize);
    observer.observe(v);
    resize();
    return () => {
      observer.disconnect();
      d.close();
    };
  }, [room]);
  const scale = diagramScale(image.value, room.value, zoom.value);
  return (
    <dialog
      class="diagram-viewer"
      aria-labelledby="diagram-title"
      ref={dialog}
      onClose={onClose}
    >
      <div class="diagram-toolbar">
        <div class="diagram-heading">
          <div class="wordmark">
            <Mark />
            MLX Spy
          </div>
          <h2 id="diagram-title" title={title}>
            {title}
          </h2>
        </div>
        <div class="diagram-controls">
          <button
            type="button"
            class="ibtn"
            title="Zoom out"
            aria-label="Zoom out"
            disabled={scale <= MIN_ZOOM || failed.value}
            onClick={() => {
              zoom.value = Math.max(MIN_ZOOM, scale - ZOOM_STEP);
            }}
          >
            <Minus />
          </button>
          <output aria-label="Diagram zoom">{Math.round(scale * 100)}%</output>
          <button
            type="button"
            class="ibtn"
            title="Zoom in"
            aria-label="Zoom in"
            disabled={scale === 0 || scale >= MAX_ZOOM || failed.value}
            onClick={() => {
              zoom.value = Math.min(MAX_ZOOM, scale + ZOOM_STEP);
            }}
          >
            <Plus />
          </button>
          <button
            type="button"
            class="btn"
            disabled={failed.value}
            onClick={() => {
              zoom.value = null;
            }}
          >
            Fit
          </button>
        </div>
        <button
          type="button"
          class="ibtn diagram-close"
          title="Close (Esc)"
          aria-label="Close diagram"
          onClick={() => dialog.current?.close()}
        >
          <Close />
        </button>
      </div>
      <section
        class="diagram-viewport"
        ref={viewport}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the zoomed diagram.
        tabIndex={0}
        aria-label="Diagram, scroll to pan when zoomed"
      >
        <div class="diagram-canvas">
          <img
            src={src}
            alt="Mermaid diagram"
            hidden={failed.value}
            style={
              scale > 0
                ? {
                    width: image.value.width * scale,
                    height: image.value.height * scale,
                  }
                : { visibility: "hidden" }
            }
            onLoad={(ev) => {
              image.value = {
                width: ev.currentTarget.naturalWidth,
                height: ev.currentTarget.naturalHeight,
              };
            }}
            onError={() => {
              failed.value = true;
            }}
          />
          {failed.value && <p role="alert">Diagram could not be loaded.</p>}
        </div>
      </section>
    </dialog>
  );
}
