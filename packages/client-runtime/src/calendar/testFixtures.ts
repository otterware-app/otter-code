import type { CalendarEventInstance } from "@t3tools/contracts";
import { fromZoned, parseDayNumber, type DayNumber } from "@t3tools/shared/calendar/time";

export function day(value: string): DayNumber {
  const parsed = parseDayNumber(value);
  if (parsed === null) throw new Error(`Bad date ${value}`);
  return parsed;
}

/** A timed instance from local wall times, e.g. `timed("a", "2026-09-30", "09:00", "10:30", zone)`. */
export function timed(
  id: string,
  date: string,
  from: string,
  to: string,
  zone: string,
  extra: Partial<CalendarEventInstance> = {},
  toDate = date,
): CalendarEventInstance {
  return instance(id, {
    start: fromZoned(day(date), minutes(from), zone),
    end: fromZoned(day(toDate), minutes(to), zone),
    ...extra,
  });
}

/** An all-day instance over [from, toExclusive). */
export function allDay(
  id: string,
  from: string,
  toExclusive: string,
  extra: Partial<CalendarEventInstance> = {},
): CalendarEventInstance {
  return instance(id, {
    start: day(from) * 86_400_000,
    end: day(toExclusive) * 86_400_000,
    allDay: true,
    ...extra,
  });
}

export function instance(
  id: string,
  fields: Partial<CalendarEventInstance> & { start: number; end: number },
): CalendarEventInstance {
  return {
    calendarId: "cal" as CalendarEventInstance["calendarId"],
    eventId: id,
    title: id,
    ...fields,
  };
}

export function minutes(value: string): number {
  const [hours, mins] = value.split(":").map(Number);
  return hours! * 60 + mins!;
}
