/** Words for the calendar's page chrome: account states, event details, links. */
import {
  type HourFormat,
  formatLongDate,
  formatRangeTitle,
  formatTime,
  formatTimeRange,
  formatZoneName,
} from "@t3tools/client-runtime/calendar/format";
import type { CalendarAccount, CalendarEventInstance } from "@t3tools/contracts";
import { DAY_MS, civilDate, toZoned, type DayNumber } from "@t3tools/shared/calendar/time";

import { formatRelativeTimeLabel } from "../../timestampFormat";

export function accountNeedsAttention(account: CalendarAccount): boolean {
  return account.status === "error" || account.status === "signed_out";
}

/** "Synced 5m ago", or "Synced" when the time is unknown. */
export function syncedLabel(lastSyncedAt: number | undefined): string {
  return lastSyncedAt === undefined
    ? "Synced"
    : `Synced ${formatRelativeTimeLabel(new Date(lastSyncedAt).toISOString())}`;
}

export function accountStatusLabel(account: CalendarAccount): string {
  switch (account.status) {
    case "signed_out":
      return "Signed out · Reconnect";
    case "error":
      return account.error ?? "Sync failed";
    case "syncing":
      return "Syncing…";
    case "ok":
      return syncedLabel(account.lastSyncedAt);
  }
}

const dateWithoutYear = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/** "Tuesday, September 29", with the year only when it is not the current one. */
function eventDate(day: DayNumber): string {
  return civilDate(day).year === new Date().getUTCFullYear()
    ? dateWithoutYear.format(day * DAY_MS)
    : formatLongDate(day);
}

/**
 * The popover's when-line, in the viewer's zone: "Wednesday, September 30 · 9:30 – 10:30 AM",
 * "Wednesday, September 30" (all day), or a range across days.
 */
export function describeEventWhen(
  instance: Pick<CalendarEventInstance, "start" | "end" | "allDay">,
  zone: string,
  hourFormat: HourFormat,
): string {
  if (instance.allDay === true) {
    const first = Math.floor(instance.start / DAY_MS);
    const last = Math.max(first, Math.floor(instance.end / DAY_MS) - 1);
    return last === first ? eventDate(first) : formatRangeTitle(first, last);
  }
  const start = toZoned(instance.start, zone);
  const end = toZoned(Math.max(instance.start, instance.end - 1), zone);
  if (start.day === end.day) {
    return `${eventDate(start.day)} · ${formatTimeRange(instance.start, instance.end, zone, hourFormat)}`;
  }
  return `${eventDate(start.day)}, ${formatTime(instance.start, zone, hourFormat)} – ${eventDate(toZoned(instance.end, zone).day)}, ${formatTime(instance.end, zone, hourFormat)}`;
}

/** "10:30 – 11:30 AM in Europe/Berlin (GMT+2)" when the event's own zone differs from the view's. */
export function describeEventZone(
  instance: Pick<CalendarEventInstance, "start" | "end" | "allDay">,
  eventZone: string | undefined,
  viewZone: string,
  hourFormat: HourFormat,
): string | null {
  if (instance.allDay === true || eventZone === undefined || eventZone === viewZone) return null;
  const sameOffset =
    toZoned(instance.start, eventZone).minutes === toZoned(instance.start, viewZone).minutes &&
    toZoned(instance.start, eventZone).day === toZoned(instance.start, viewZone).day;
  if (sameOffset) return null;
  return `${formatTimeRange(instance.start, instance.end, eventZone, hourFormat)} in ${eventZone.replace(/_/g, " ")} (${formatZoneName(eventZone, instance.start)})`;
}

/** A link for a location: the URL itself, or a map search for something that reads as a place. */
export function locationHref(location: string): string | null {
  const trimmed = location.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.length < 4) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(trimmed)}`;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}
