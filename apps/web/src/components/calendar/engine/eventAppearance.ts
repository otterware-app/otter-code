import type { Calendar, CalendarEventInstance } from "@t3tools/contracts";
import type { CSSProperties } from "react";

/** Used when an instance's calendar is unknown (it is loading or was just removed). */
const FALLBACK_COLOR = "#8e8e93";

export function eventColor(
  instance: CalendarEventInstance,
  calendars: ReadonlyMap<string, Calendar>,
): string {
  return instance.color ?? calendars.get(instance.calendarId)?.color ?? FALLBACK_COLOR;
}

/** Whether the user may move or resize the event here. */
export function isEventReadOnly(
  instance: CalendarEventInstance,
  calendars: ReadonlyMap<string, Calendar>,
): boolean {
  if (instance.readOnly === true) return true;
  const role = calendars.get(instance.calendarId)?.accessRole;
  return role === "reader" || role === "freeBusyReader";
}

/** Boolean data attribute: present (`""`) when true, absent otherwise. */
export function flag(value: boolean): "" | undefined {
  return value ? "" : undefined;
}

export function eventColorStyle(color: string): CSSProperties {
  return { "--event-color": color } as CSSProperties;
}

export const EMPTY_KEYS: ReadonlySet<string> = new Set();
