// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // The Studio's HTTP origin has no Clipboard API. The legacy command
  // still works there, provided it runs synchronously in the user's click.
  const error = "Copy failed. Select the text and copy it manually.";
  if (typeof document.execCommand !== "function") throw new Error(error);
  const focused = document.activeElement;
  const field =
    focused instanceof HTMLInputElement ||
    focused instanceof HTMLTextAreaElement
      ? focused
      : null;
  const caret = field
    ? {
        start: field.selectionStart,
        end: field.selectionEnd,
        direction: field.selectionDirection,
      }
    : null;
  const selection = document.getSelection();
  const ranges = Array.from({ length: selection?.rangeCount ?? 0 }, (_, i) =>
    selection!.getRangeAt(i).cloneRange(),
  );
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");
  input.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px";
  try {
    (focused?.closest("dialog[open]") ?? document.body).append(input);
    input.focus({ preventScroll: true });
    input.select();
    input.setSelectionRange(0, text.length);
    if (!document.execCommand("copy")) throw new Error(error);
  } finally {
    input.remove();
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
    if (focused instanceof HTMLElement && focused.isConnected) {
      focused.focus({ preventScroll: true });
    }
    if (
      field?.isConnected &&
      caret &&
      caret.start !== null &&
      caret.end !== null
    ) {
      field.setSelectionRange(
        caret.start,
        caret.end,
        caret.direction ?? undefined,
      );
    }
  }
}
