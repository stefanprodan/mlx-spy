// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { sample } from "../store.ts";
import { initialMemory, type RequestMemory, requestBar } from "./request.ts";

let memory: RequestMemory = initialMemory;

export function RequestBar() {
  const next = requestBar(memory, sample.value);
  memory = next.memory;
  const bar = next.bar;
  const hasPrefill = Boolean(
    bar.prefillText || bar.cachedText || bar.prefillRateText,
  );
  return (
    <div class="spark request">
      <div class="cur-head">
        <span class={bar.stateClass}>{bar.state}</span>
        <span class="cur-when">{bar.when}</span>
        <span class="grow" />
        <span class="cur-num">{bar.tokens}</span>
      </div>
      <div class={bar.barClass}>
        <span class="pf" style={{ width: `${bar.prefillWidth}%` }} />
        <span class="dc" style={{ width: `${bar.decodeWidth}%` }} />
      </div>
      <div class="cur-foot">
        <span class="cur-pf" hidden={!hasPrefill}>
          {bar.prefillText}
          {bar.cachedText && <span class="cur-cached">{bar.cachedText}</span>}
          {bar.prefillRateText}
        </span>
        <span class="cur-dc" hidden={!bar.decodeText}>
          {bar.decodeText}
        </span>
        <span class="grow" />
        <span class="cur-total">
          {bar.totalText}
          {bar.waitingText && (
            <>
              {" · "}
              <span class="warn">{bar.waitingText}</span>
            </>
          )}
        </span>
      </div>
    </div>
  );
}
