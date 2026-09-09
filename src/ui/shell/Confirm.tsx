// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The confirm dialog with a promise API: confirm() writes the request into
// a signal, the component opens the <dialog> in an effect and resolves
// the promise when it closes.

import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { TextPart } from "../monitor/actions.ts";

type Request = {
  text: TextPart[];
  okLabel: string;
  // shows the "also delete the SSD tier" checkbox, unchecked; the answer
  // carries its state
  diskSize?: string;
  resolve: (a: { ok: boolean; checked: boolean }) => void;
};

const request = signal<Request | null>(null);

export function confirm(
  text: TextPart[],
  okLabel: string,
  diskSize?: string,
): Promise<{ ok: boolean; checked: boolean }> {
  return new Promise((resolve) => {
    // one dialog at a time: a request still pending is answered "no"
    request.peek()?.resolve({ ok: false, checked: false });
    request.value = { text, okLabel, diskSize, resolve };
  });
}

export function Confirm() {
  const req = request.value;
  const dlg = useRef<HTMLDialogElement>(null);
  const check = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const d = dlg.current;
    if (!req || !d) return;
    if (check.current) check.current.checked = false;
    d.returnValue = "";
    d.showModal();
  }, [req]);
  const onClose = () => {
    if (!req) return;
    request.value = null;
    req.resolve({
      ok: dlg.current?.returnValue === "ok",
      checked: check.current?.checked ?? false,
    });
  };
  return (
    <dialog id="confirm" ref={dlg} onClose={onClose}>
      <form method="dialog">
        <p>
          {(req?.text ?? []).map((part, i) =>
            typeof part === "string" ? part : <code key={i}>{part.code}</code>,
          )}
        </p>
        <label class="opt" hidden={!req?.diskSize}>
          <input type="checkbox" ref={check} />
          <span>Delete {req?.diskSize ?? ""} of SSD cache</span>
        </label>
        <div class="row">
          <button type="submit" value="cancel" class="btn">
            Cancel
          </button>
          <button type="submit" value="ok" class="btn primary">
            {req?.okLabel ?? "Confirm"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
