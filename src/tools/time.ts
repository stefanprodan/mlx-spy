// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The clock the tools and the runner share, formatted in a timezone. The
// page imports this too, to show the date line the runner sends.

export type CurrentTime = {
  timezone: string;
  datetime: string;
  day_of_week: string;
};

export const HOST_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function part(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((item) => item.type === type)?.value ?? "";
}

export function formatCurrentTime(
  epochMs: number,
  timezone: string,
): CurrentTime {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      weekday: "long",
      timeZoneName: "longOffset",
    }).formatToParts(new Date(epochMs));
  } catch {
    throw new Error(`unknown timezone "${timezone}"`);
  }
  const offsetName = part(parts, "timeZoneName");
  const offset = offsetName === "GMT" ? "+00:00" : offsetName.slice(3);
  return {
    timezone,
    datetime: `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}T${part(parts, "hour")}:${part(parts, "minute")}:${part(parts, "second")}${offset}`,
    day_of_week: part(parts, "weekday"),
  };
}

// the line the runner appends to the system prompt while a tool is on
export function dateLine(epochMs: number, timezone: string): string {
  const date = formatCurrentTime(epochMs, timezone);
  return `Today's date: ${date.day_of_week}, ${date.datetime.slice(0, 10)}`;
}
