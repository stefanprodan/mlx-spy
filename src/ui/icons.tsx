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
