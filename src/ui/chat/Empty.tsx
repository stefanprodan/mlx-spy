// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { modelInfo, settings, short } from "./store.ts";

// what the transcript shows before the first message
export function Empty() {
  const s = settings.value;
  const info = s.model ? modelInfo(s.provider, s.model) : null;
  return (
    <div class="empty">
      <p>
        {s.model ? (
          <>
            Start a chat with <b>{short(s.model)}</b>
          </>
        ) : (
          "Pick a model to start a chat."
        )}
      </p>
      {info && !info.loaded && (
        <small>The model is not loaded; the first message loads it.</small>
      )}
      {s.provider === "openrouter" && (
        <small>
          This chat runs on OpenRouter: the conversation leaves this host.
        </small>
      )}
    </div>
  );
}
