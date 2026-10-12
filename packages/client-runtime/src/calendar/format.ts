// @effect-diagnostics globalDate:off - Intl formats Date objects; the math stays on epoch ms.
/**
 * Labels for calendar views: hour gutters, event times, day headers, titles and durations.
 * Formatters are cached per options and zone (constructing an `Intl.DateTimeFormat` costs far
 * more than formatting), so views can call these per event per render.
 *
 * Civil days (`DayNumber`) format in UTC, so they never shift with the device's zone.
 *
 * @module calendar/format
 */
import type { CalendarEventInstance, CalendarPreferences } from "@t3tools/contracts";
import { DAY_MS, MINUTE_MS, type DayNumber, toZoned } from "@t3tools/shared/calendar/time";

export type HourFormat = CalendarPreferences["hourFormat"];

let calendarLocale: string | undefined;

/** Sets the locale for every label (defaults to the runtime's); clears the formatter cache. */
export function setCalendarLocale(locale: string | undefined): void {
  calendarLocale = locale;
  formatters.clear();
  twelveHourCache.clear();
  minuteLabels.clear();
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let cached = formatters.get(key);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat(calendarLocale, options);
    formatters.set(key, cached);
  }
  return cached;
}

function hourCycleOptions(hourFormat: HourFormat): Intl.DateTimeFormatOptions {
  if (hourFormat === "12") return { hourCycle: "h12" };
  if (hourFormat === "24") return { hourCycle: "h23" };
  return {};
}

const twelveHourCache = new Map<HourFormat, boolean>();

/** Whether times show a day period (AM/PM) under this preference and locale. */
export function usesTwelveHour(hourFormat: HourFormat): boolean {
  let twelve = twelveHourCache.get(hourFormat);
  if (twelve === undefined) {
    const cycle = formatter({
      hour: "numeric",
      timeZone: "UTC",
      ...hourCycleOptions(hourFormat),
    }).resolvedOptions().hourCycle;
    twelve = cycle === "h12" || cycle === "h11";
    twelveHourCache.set(hourFormat, twelve);
  }
  return twelve;
}

function timeOptions(hourFormat: HourFormat, zone: string): Intl.DateTimeFormatOptions {
  const twelve = usesTwelveHour(hourFormat);
  return {
    hour: twelve ? "numeric" : "2-digit",
    minute: "2-digit",
    hourCycle: twelve ? "h12" : "h23",
    timeZone: zone,
  };
}

// ── Times ────────────────────────────────────────────────────────────

/** The time gutter's label for an hour (0–23): "9 AM" or "09:00". */
export function formatHourLabel(hour: number, hourFormat: HourFormat): string {
  const at = Date.UTC(2000, 0, 1, hour);
  if (usesTwelveHour(hourFormat)) {
    return formatter({ hour: "numeric", hourCycle: "h12", timeZone: "UTC" }).format(at);
  }
  return formatter(timeOptions(hourFormat, "UTC")).format(at);
}

interface TimeParts {
  readonly text: string;
  readonly period: string | null;
  readonly withoutPeriod: string;
}

/** Formatted wall-clock minutes (0–1439) per hour format: a view repeats the same few times. */
const minuteLabels = new Map<HourFormat, Array<TimeParts | undefined>>();

function timeParts(ms: number, zone: string, hourFormat: HourFormat): TimeParts {
  // The label depends only on the wall-clock minute, so format that once in UTC and reuse it
  // for every instant (and zone) that shows the same time.
  const minute = Math.floor(toZoned(ms, zone).minutes);
  let labels = minuteLabels.get(hourFormat);
  if (labels === undefined) {
    labels = [];
    minuteLabels.set(hourFormat, labels);
  }
  let cached = labels[minute];
  if (cached === undefined) {
    cached = formatMinuteParts(minute * MINUTE_MS, hourFormat);
    labels[minute] = cached;
  }
  return cached;
}

function formatMinuteParts(ms: number, hourFormat: HourFormat): TimeParts {
  const parts = formatter(timeOptions(hourFormat, "UTC")).formatToParts(ms);
  const twelve = usesTwelveHour(hourFormat);
  let period: string | null = null;
  let text = "";
  let withoutPeriod = "";
  let wholeHour = false;
  for (const part of parts) {
    if (part.type === "minute") wholeHour = part.value === "00";
  }
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    // "9 AM" instead of "9:00 AM"; 24-hour clocks keep "09:00".
    if (twelve && wholeHour && (part.type === "minute" || isMinuteSeparator(parts, index))) {
      continue;
    }
    text += part.value;
    if (part.type === "dayPeriod") period = part.value;
    else withoutPeriod += part.value;
  }
  return { text, period, withoutPeriod: withoutPeriod.trim() };
}

function isMinuteSeparator(parts: ReadonlyArray<Intl.DateTimeFormatPart>, index: number): boolean {
  return parts[index]!.type === "literal" && parts[index + 1]?.type === "minute";
}

/** An instant's wall-clock time in a zone: "9:30 AM", "9 AM" or "09:30". */
export function formatTime(ms: number, zone: string, hourFormat: HourFormat): string {
  return timeParts(ms, zone, hourFormat).text;
}

/** A wall-clock time from minutes after midnight (zone-free): "9:30 AM" or "09:30". */
export function formatMinutes(minutes: number, hourFormat: HourFormat): string {
  return formatTime(Math.round(minutes) * MINUTE_MS, "UTC", hourFormat);
}

/**
 * "9:30 – 10:30 AM", "11 AM – 1 PM" or "09:30 – 10:30". The first day period is dropped when
 * both ends share it.
 */
export function formatTimeRange(
  start: number,
  end: number,
  zone: string,
  hourFormat: HourFormat,
): string {
  const from = timeParts(start, zone, hourFormat);
  const to = timeParts(end, zone, hourFormat);
  const first = from.period !== null && from.period === to.period ? from.withoutPeriod : from.text;
  return `${first} – ${to.text}`;
}

/** `formatTimeRange` for wall-clock minutes (zone-free), e.g. for a drag preview. */
export function formatMinutesRange(
  startMinutes: number,
  endMinutes: number,
  hourFormat: HourFormat,
): string {
  return formatTimeRange(
    Math.round(startMinutes) * MINUTE_MS,
    Math.round(endMinutes) * MINUTE_MS,
    "UTC",
    hourFormat,
  );
}

/** "30 min", "1 hr", "1 hr 45 min", "1 day", "3 days". */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total >= 1440 && total % 1440 === 0) {
    const days = total / 1440;
    return days === 1 ? "1 day" : `${days} days`;
  }
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** The zone's short name at an instant, e.g. "GMT+2" or "PDT". */
export function formatZoneName(zone: string, at: number): string {
  const parts = formatter({ timeZone: zone, timeZoneName: "short" }).formatToParts(at);
  return parts.find((part) => part.type === "timeZoneName")?.value ?? zone;
}

// ── Days ─────────────────────────────────────────────────────────────

function dayMs(day: DayNumber): number {
  return day * DAY_MS;
}

/** Column header parts: `{ weekday: "Mon", date: "28" }`. */
export function formatDayHeader(day: DayNumber): {
  readonly weekday: string;
  readonly date: string;
} {
  return {
    weekday: formatter({ weekday: "short", timeZone: "UTC" }).format(dayMs(day)),
    date: formatter({ day: "numeric", timeZone: "UTC" }).format(dayMs(day)),
  };
}

/** A weekday name for month headers: "Mon" (`short`) or "M" (`narrow`). */
export function formatWeekdayName(day: DayNumber, width: "short" | "narrow" = "short"): string {
  return formatter({ weekday: width, timeZone: "UTC" }).format(dayMs(day));
}

/** "Wed, Sep 30". */
export function formatShortDate(day: DayNumber): string {
  return formatter({ weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(
    dayMs(day),
  );
}

/** "Wednesday, September 30, 2026". */
export function formatLongDate(day: DayNumber): string {
  return formatter({
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(dayMs(day));
}

/** "September 2026". */
export function formatMonthTitle(day: DayNumber): string {
  return formatter({ month: "long", year: "numeric", timeZone: "UTC" }).format(dayMs(day));
}

/** "Sep 1" for the first day of a month in a month grid, else "2". */
export function formatMonthCellDate(day: DayNumber, withMonth: boolean): string {
  return withMonth
    ? formatter({ month: "short", day: "numeric", timeZone: "UTC" }).format(dayMs(day))
    : formatter({ day: "numeric", timeZone: "UTC" }).format(dayMs(day));
}

/**
 * A toolbar title for days [first, last]: "Sep 28 – Oct 4, 2026", "Oct 5 – 11, 2026",
 * "Dec 28, 2026 – Jan 3, 2027", or "Sep 30, 2026" for one day.
 */
export function formatRangeTitle(first: DayNumber, last: DayNumber): string {
  const format = formatter({ month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  if (last <= first) return format.format(dayMs(first));
  // Hermes may lack formatRange; the fallback repeats the year.
  if (typeof format.formatRange === "function") {
    return format.formatRange(dayMs(first), dayMs(last));
  }
  return `${format.format(dayMs(first))} – ${format.format(dayMs(last))}`;
}

/** "Today", "Tomorrow", "Yesterday", or the short date. */
export function formatRelativeDay(day: DayNumber, today: DayNumber): string {
  if (day === today) return "Today";
  if (day === today + 1) return "Tomorrow";
  if (day === today - 1) return "Yesterday";
  return formatShortDate(day);
}

// ── Events ───────────────────────────────────────────────────────────

/**
 * An event's (or a proposed change's) time: "9:30 – 10:30 AM", "All day", "Oct 1 – 3, 2026",
 * or "Wed, Sep 30, 10 PM – Thu, Oct 1, 2 AM" across days.
 */
export function formatEventTime(
  instance: Pick<CalendarEventInstance, "start" | "end" | "allDay">,
  zone: string,
  hourFormat: HourFormat,
): string {
  if (instance.allDay === true) {
    const first = Math.floor(instance.start / DAY_MS);
    const last = Math.max(first, Math.floor(instance.end / DAY_MS) - 1);
    return last === first ? "All day" : formatRangeTitle(first, last);
  }
  const start = toZoned(instance.start, zone);
  const end = toZoned(Math.max(instance.start, instance.end - 1), zone);
  if (start.day === end.day) return formatTimeRange(instance.start, instance.end, zone, hourFormat);
  return `${formatShortDate(start.day)}, ${formatTime(instance.start, zone, hourFormat)} – ${formatShortDate(toZoned(instance.end, zone).day)}, ${formatTime(instance.end, zone, hourFormat)}`;
}

const RESPONSE_LABELS: Record<NonNullable<CalendarEventInstance["response"]>, string | null> = {
  accepted: null,
  declined: "Declined",
  tentative: "Maybe",
  needsAction: "Not answered",
};

/** The user's RSVP as a short label, or null when accepted or not invited. */
export function formatResponse(instance: CalendarEventInstance): string | null {
  if (instance.response !== undefined) return RESPONSE_LABELS[instance.response];
  return instance.tentative === true ? "Tentative" : null;
}

/** A screen-reader label: "Standup, Wed, Sep 30, 9 – 9:30 AM, Room 3, Maybe". */
export function formatEventLabel(
  instance: CalendarEventInstance,
  zone: string,
  hourFormat: HourFormat,
): string {
  const day =
    instance.allDay === true
      ? Math.floor(instance.start / DAY_MS)
      : toZoned(instance.start, zone).day;
  const parts = [
    instance.title || "(No title)",
    formatShortDate(day),
    formatEventTime(instance, zone, hourFormat),
  ];
  if (instance.location) parts.push(instance.location);
  const response = formatResponse(instance);
  if (response !== null) parts.push(response);
  return parts.join(", ");
}
