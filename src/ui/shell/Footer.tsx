// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { version } from "../store.ts";

export function Footer() {
  const v = version.value;
  return (
    <>
      <a
        class="footlink"
        href="https://github.com/stefanprodan/mlx-spy"
        target="_blank"
        rel="noopener"
      >
        {v ? `mlx-spy ${v}` : "mlx-spy"}
      </a>
      <span class="grow" />
      <span>
        &copy; 2026{" "}
        <a
          class="footlink"
          href="https://stefanprodan.com"
          target="_blank"
          rel="noopener"
        >
          Stefan Prodan
        </a>
      </span>
    </>
  );
}
