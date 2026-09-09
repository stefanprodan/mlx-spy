// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The inline SVGs as components, so a page can drop one in without
// carrying the path data around.

// the wordmark's chip with a sparkle, also the favicon in index.html
export const Mark = () => (
  <svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.5"
      d="M13.5 4H11C6.757 4 4.636 4 3.318 5.318S2 8.758 2 13s0 6.364 1.318 7.682S6.758 22 11 22s6.364 0 7.682-1.318S20 17.242 20 13v-2.5M6 8l10 10M6 14l4 4m2-10l4 4m3.5-9.062V4.5m0 0v1.563m0-1.563h-1.25m1.25 0h1.25m1.25 0l-1.084-.361a1.67 1.67 0 0 1-1.055-1.055L19.5 2l-.361 1.084a1.67 1.67 0 0 1-1.055 1.055L17 4.5l1.084.361c.498.166.889.557 1.055 1.055L19.5 7l.361-1.084a1.67 1.67 0 0 1 1.055-1.055z"
    />
  </svg>
);

// the clear buttons in the section heads
export const Trash = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.75"
      d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"
    />
  </svg>
);

// the Download button in the Models head
export const Download = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.75"
      d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"
    />
  </svg>
);

const stroke = {
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2",
  "stroke-linecap": "round",
} as const;

// the fold marker of think, tool and work blocks; CSS turns it when open
export const Chevron = () => (
  <svg
    viewBox="0 0 24 24"
    {...stroke}
    stroke-width="2.5"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

// the model button's "there is a list" mark
export const Caret = () => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export const Plus = () => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const Lines = () => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h10" />
  </svg>
);

export const Gear = () => (
  <svg
    viewBox="0 0 24 24"
    {...stroke}
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

// the send button carries both glyphs; CSS shows one by the "stop" class
export const SendStop = () => (
  <>
    <svg
      class="i-send"
      viewBox="0 0 24 24"
      {...stroke}
      stroke-width="2.5"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
    <svg
      class="i-stop"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  </>
);
