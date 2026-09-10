// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { copyToClipboard } from "../../src/ui/clipboard.ts";

const globals = [
  "navigator",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
];
const originals = new Map(
  globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
let active: ElementStub | null;

class ElementStub {
  isConnected = true;
  children: ElementStub[] = [];
  parent: ElementStub | null = null;
  focus = mock((_options?: FocusOptions) => {
    active = this;
  });
  closest = mock((_selector: string): ElementStub | null => null);
  append = mock((node: ElementStub) => {
    node.parent = this;
    this.children.push(node);
  });
  remove = mock(() => {
    if (this.parent) {
      this.parent.children = this.parent.children.filter(
        (node) => node !== this,
      );
    }
    this.isConnected = false;
  });
}

class TextAreaStub extends ElementStub {
  value = "";
  readOnly = false;
  tabIndex = 0;
  style = { cssText: "" };
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  selectionDirection: "forward" | "backward" | "none" | null = "none";
  setAttribute = mock((_name: string, _value: string) => {});
  select = mock(() => {});
  setSelectionRange = mock(
    (
      start: number,
      end: number,
      direction?: "forward" | "backward" | "none",
    ) => {
      this.selectionStart = start;
      this.selectionEnd = end;
      this.selectionDirection = direction ?? "none";
    },
  );
}
class InputStub extends TextAreaStub {}

let input: TextAreaStub;
let focused: TextAreaStub;
let body: ElementStub;
let browser: ReturnType<typeof browserDocument>;
const range = {};
const selection = {
  rangeCount: 1,
  getRangeAt: mock((_index: number) => ({
    cloneRange: () => range,
  })),
  removeAllRanges: mock(() => {}),
  addRange: mock((_range: object) => {}),
};
function browserDocument() {
  return {
    get activeElement() {
      return active;
    },
    body,
    createElement: mock((_tag: string) => input),
    getSelection: mock((): typeof selection | null => selection),
    execCommand: mock((_command: string) => true),
  };
}

beforeEach(() => {
  input = new TextAreaStub();
  focused = new TextAreaStub();
  focused.selectionStart = 2;
  focused.selectionEnd = 5;
  focused.selectionDirection = "backward";
  active = focused;
  body = new ElementStub();
  browser = browserDocument();
  selection.getRangeAt.mockClear();
  selection.removeAllRanges.mockClear();
  selection.addRange.mockReset();
  Object.defineProperties(globalThis, {
    navigator: { configurable: true, value: {} },
    document: { configurable: true, value: browser },
    HTMLElement: { configurable: true, value: ElementStub },
    HTMLInputElement: { configurable: true, value: InputStub },
    HTMLTextAreaElement: { configurable: true, value: TextAreaStub },
  });
});

afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe("copyToClipboard", () => {
  test("awaits the native Clipboard API without touching the page", async () => {
    const result = Promise.withResolvers<void>();
    const writeText = mock(() => result.promise);
    Object.defineProperty(navigator, "clipboard", { value: { writeText } });
    const pending = copyToClipboard("native text");
    expect(writeText).toHaveBeenCalledWith("native text");
    expect(browser.createElement).not.toHaveBeenCalled();
    result.resolve();
    await pending;
    expect(browser.execCommand).not.toHaveBeenCalled();
  });

  test("native permission failures are reported rather than silently retried", async () => {
    const error = new Error("Permission denied");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mock(() => Promise.reject(error)) },
    });
    await expect(copyToClipboard("text")).rejects.toBe(error);
    expect(browser.execCommand).not.toHaveBeenCalled();
  });

  test("HTTP fallback copies synchronously and restores focus and selections", async () => {
    const text = 'line 1\n<code> & "quotes"\n\u00e9';
    browser.execCommand.mockImplementation(() => {
      expect(active).toBe(input);
      expect(body.children).toEqual([input]);
      expect(input.value).toBe(text);
      expect(input.readOnly).toBe(true);
      expect(input.setSelectionRange).toHaveBeenCalledWith(0, text.length);
      return true;
    });
    const pending = copyToClipboard(text);
    expect(browser.execCommand).toHaveBeenCalledWith("copy");
    await pending;
    expect(body.children).toEqual([]);
    expect(input.remove).toHaveBeenCalledTimes(1);
    expect(active).toBe(focused);
    expect(focused.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(focused.setSelectionRange).toHaveBeenCalledWith(2, 5, "backward");
    expect(selection.addRange).toHaveBeenCalledWith(range);
  });

  test("a refused command still cleans up and reports a useful error", async () => {
    browser.execCommand.mockReturnValue(false);
    await expect(copyToClipboard("text")).rejects.toThrow(
      "Copy failed. Select the text and copy it manually.",
    );
    expect(body.children).toEqual([]);
    expect(active).toBe(focused);
    expect(focused.setSelectionRange).toHaveBeenCalledWith(2, 5, "backward");
  });

  test("restores focus after the document selection moves it", async () => {
    selection.addRange.mockImplementation(() => {
      active = new ElementStub();
    });
    await copyToClipboard("text");
    expect(active).toBe(focused);
  });

  test("a thrown command still restores the page", async () => {
    const error = new Error("Copy blocked");
    browser.execCommand.mockImplementation(() => {
      throw error;
    });
    await expect(copyToClipboard("text")).rejects.toBe(error);
    expect(input.remove).toHaveBeenCalledTimes(1);
    expect(active).toBe(focused);
    expect(selection.addRange).toHaveBeenCalledWith(range);
  });

  test("a browser without either clipboard method reports the failure", async () => {
    Object.defineProperty(browser, "execCommand", { value: undefined });
    await expect(copyToClipboard("text")).rejects.toThrow("copy it manually");
    expect(browser.createElement).not.toHaveBeenCalled();
  });

  test("keeps the temporary selection inside an open modal", async () => {
    const dialog = new ElementStub();
    focused.closest.mockReturnValue(dialog);
    await copyToClipboard("text");
    expect(dialog.append).toHaveBeenCalledWith(input);
    expect(body.append).not.toHaveBeenCalled();
    expect(dialog.children).toEqual([]);
  });

  test("handles missing document selection and non-text input focus", async () => {
    const numberInput = new InputStub();
    numberInput.selectionStart = null;
    numberInput.selectionEnd = null;
    active = numberInput;
    browser.getSelection.mockReturnValue(null);
    await copyToClipboard("text");
    expect(active).toBe(numberInput);
    expect(numberInput.setSelectionRange).not.toHaveBeenCalled();
  });
});
