// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Mark } from "../icons.tsx";
import type { Page } from "../store.ts";
import { Pill } from "./Pill.tsx";

const PAGES: { page: Page; href: string; label: string }[] = [
  { page: "monitor", href: "/", label: "Monitor" },
  { page: "requests", href: "/requests", label: "Requests" },
  { page: "chat", href: "/chat", label: "Chat" },
];

// The wordmark and the nav. The chat page has no section head to hold
// the connection pill, so it sits at the header's right end there.
export function Header({ page }: { page: Page }) {
  return (
    <>
      <div class="wordmark">
        <Mark />
        MLX Spy
      </div>
      <nav class="menu">
        {PAGES.map((p) => (
          <a
            key={p.page}
            href={p.href}
            class={p.page === page ? "active" : undefined}
          >
            {p.label}
          </a>
        ))}
      </nav>
      {page === "chat" && (
        <>
          <span class="grow" />
          <Pill />
        </>
      )}
    </>
  );
}
