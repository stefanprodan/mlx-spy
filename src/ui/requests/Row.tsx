// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { LastRequest } from "../../requests.ts";
import { count, DASH } from "../format.ts";

const fmtStamp = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const whole = (value: number) => `${Math.max(1, Math.round(value))}`;
const short = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${seconds}s`;
};
const duration = (ms: number) =>
  ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : short(ms);
const tps = (tokens: number, ms: number) =>
  tokens > 0 && ms > 0 ? `${whole((tokens / ms) * 1000)} tok/s` : "";

function NumberCell({
  text,
  rate,
  className = "",
}: {
  text: string;
  rate?: string;
  className?: string;
}) {
  return (
    <td class={`num${className ? ` ${className}` : ""}`}>
      {text}
      {rate && <span class="rate"> · {rate}</span>}
    </td>
  );
}

function DetailCell({ label, value }: { label: string; value: string }) {
  return (
    <div class="d">
      <span class="k">{label}</span>
      <span class="v">{value}</span>
    </div>
  );
}

export function Row({
  request,
  open,
  onToggle,
}: {
  request: LastRequest;
  open: boolean;
  onToggle: () => void;
}) {
  const cached = request.promptTokens - request.prefillTokens;
  const engineMs = request.prefillMs + request.decodeMs;
  const total =
    engineMs > 0
      ? engineMs
      : request.startedAt == null
        ? 0
        : request.finishedAt - request.startedAt;
  const rowClass = [request.cancelled ? "cancelled" : "", open ? "open" : ""]
    .filter(Boolean)
    .join(" ");
  const model = request.model?.split("/").pop() ?? DASH;
  const prefillRate = tps(request.prefillTokens, request.prefillMs);
  const decodeRate = tps(request.generated, request.decodeMs);
  return (
    <>
      <tr class={rowClass || undefined} onClick={onToggle}>
        <td
          class="when"
          title={request.cancelled ? "cancelled by the client" : undefined}
        >
          <span class="chev" />
          <span class="fin">{fmtStamp.format(request.finishedAt)}</span>
          {request.count > 1 && <span class="tag">×{request.count}</span>}
        </td>
        <td class="model" title={request.model ?? undefined}>
          {model}
        </td>
        <NumberCell
          text={request.promptTokens > 0 ? count(request.promptTokens) : DASH}
        />
        <NumberCell
          className="cached"
          text={
            request.promptTokens > 0 && cached > 0
              ? `${whole((cached / request.promptTokens) * 100)}%`
              : DASH
          }
        />
        <NumberCell text={count(request.generated)} />
        <NumberCell
          className="wide"
          text={request.prefillMs ? duration(request.prefillMs) : DASH}
          rate={prefillRate}
        />
        <NumberCell
          className="wide"
          text={request.decodeMs ? duration(request.decodeMs) : DASH}
          rate={decodeRate}
        />
        <NumberCell
          className="ttft"
          text={request.ttftMs == null ? DASH : duration(request.ttftMs)}
        />
        <NumberCell className="total" text={total ? duration(total) : DASH} />
      </tr>
      <tr class="detail" hidden={!open}>
        <td colSpan={10}>
          <div class="dgrid">
            <DetailCell label="Model" value={request.model ?? "unknown"} />
            <DetailCell
              label="Started"
              value={
                request.startedAt == null
                  ? "not seen"
                  : fmtStamp.format(request.startedAt)
              }
            />
            <DetailCell
              label="Prompt"
              value={
                request.promptTokens > 0
                  ? `${count(request.promptTokens)} tok`
                  : DASH
              }
            />
            <DetailCell
              label="Cached"
              value={
                request.promptTokens > 0 && cached > 0
                  ? `${count(cached)} tok · ${whole(
                      (cached / request.promptTokens) * 100,
                    )}%`
                  : DASH
              }
            />
            <DetailCell
              label="Generated"
              value={`${count(request.generated)} tok`}
            />
            <DetailCell
              label="Prefill"
              value={
                request.prefillMs
                  ? [duration(request.prefillMs), prefillRate]
                      .filter(Boolean)
                      .join(" · ")
                  : DASH
              }
            />
            <DetailCell
              label="Decode"
              value={
                request.decodeMs
                  ? [duration(request.decodeMs), decodeRate]
                      .filter(Boolean)
                      .join(" · ")
                  : DASH
              }
            />
            <DetailCell
              label="TTFT"
              value={request.ttftMs == null ? DASH : duration(request.ttftMs)}
            />
            <DetailCell
              label="Total"
              value={
                engineMs
                  ? duration(engineMs)
                  : request.startedAt == null
                    ? DASH
                    : duration(request.finishedAt - request.startedAt)
              }
            />
            <DetailCell
              label="Outcome"
              value={
                request.cancelled
                  ? request.count > 1
                    ? `${request.count} requests cancelled by their clients in the same second`
                    : "cancelled by the client"
                  : request.count > 1
                    ? `${request.count} requests completed in the same second`
                    : "completed"
              }
            />
          </div>
        </td>
      </tr>
    </>
  );
}
