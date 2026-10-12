/**
 * What the calendar page shows for a view and a date: the days, the title, the week chunks to
 * subscribe to (and prefetch), and which instances pass the user's filters. Pure, so the page,
 * the sidebar's mini month and the palette agree on it.
 */
import { chunkWeeksForDays } from "@t3tools/client-runtime/calendar/chunks";
import {
  type CalendarViewKind,
  monthViewWeeks,
  stepAnchor,
  timeGridDays,
} from "@t3tools/client-runtime/calendar/days";
import {
  formatLongDate,
  formatMonthTitle,
  formatRangeTitle,
} from "@t3tools/client-runtime/calendar/format";
import type {
  Calendar,
  CalendarEventInstance,
  CalendarPreferences,
  KeybindingCommand,
} from "@t3tools/contracts";
import {
  type DayNumber,
  MINUTE_MS,
  civilDate,
  fromZoned,
  parseDayNumber,
  toZoned,
} from "@t3tools/shared/calendar/time";

export type { CalendarViewKind };

export const CALENDAR_VIEWS: ReadonlyArray<CalendarViewKind> = [
  "day",
  "week",
  "custom",
  "month",
  "agenda",
];

export const DEFAULT_CALENDAR_VIEW: CalendarViewKind = "week";

/** How many days the agenda lists before it asks for more. */
export const AGENDA_DAYS = 28;

export interface CalendarSearch {
  readonly view?: CalendarViewKind;
  /** `YYYY-MM-DD`; absent means today. */
  readonly date?: string;
}

export function isCalendarView(value: unknown): value is CalendarViewKind {
  return typeof value === "string" && (CALENDAR_VIEWS as ReadonlyArray<string>).includes(value);
}

/** Keeps only valid `view` and `date` params, so a bad link falls back to the defaults. */
export function validateCalendarSearch(search: Record<string, unknown>): CalendarSearch {
  const view = isCalendarView(search.view) ? search.view : undefined;
  const date =
    typeof search.date === "string" && parseDayNumber(search.date) !== null
      ? search.date
      : undefined;
  return { ...(view === undefined ? {} : { view }), ...(date === undefined ? {} : { date }) };
}

export function viewLabel(view: CalendarViewKind, customDays: number): string {
  switch (view) {
    case "day":
      return "Day";
    case "week":
      return "Week";
    case "custom":
      return `${customDays} days`;
    case "month":
      return "Month";
    case "agenda":
      return "Agenda";
  }
}

export const VIEW_COMMANDS: Readonly<
  Record<CalendarViewKind, Extract<KeybindingCommand, `calendar.view.${string}`>>
> = {
  day: "calendar.view.day",
  week: "calendar.view.week",
  custom: "calendar.view.custom",
  month: "calendar.view.month",
  agenda: "calendar.view.agenda",
};

type RangePreferences = Pick<CalendarPreferences, "weekStartsOn" | "customDays" | "showWeekends">;

export interface CalendarRange {
  readonly view: CalendarViewKind;
  readonly anchor: DayNumber;
  /** Time-grid columns (day, week, custom); every listed day for month and agenda. */
  readonly days: ReadonlyArray<DayNumber>;
  /** Month rows. */
  readonly weeks: ReadonlyArray<ReadonlyArray<DayNumber>>;
  readonly firstDay: DayNumber;
  readonly lastDay: DayNumber;
  readonly title: string;
}

function daySpan(first: DayNumber, last: DayNumber): DayNumber[] {
  const days: DayNumber[] = [];
  for (let day = first; day <= last; day++) days.push(day);
  return days;
}

/** The days a view shows around `anchor` and its title ("September 2026", "Sep 28 – Oct 4, 2026"). */
export function calendarRange(
  view: CalendarViewKind,
  anchor: DayNumber,
  preferences: RangePreferences,
  agendaDays = AGENDA_DAYS,
): CalendarRange {
  switch (view) {
    case "day":
    case "week":
    case "custom": {
      const days = timeGridDays(view, anchor, preferences);
      const firstDay = days[0] ?? anchor;
      const lastDay = days.at(-1) ?? anchor;
      const sameMonth =
        civilDate(firstDay).month === civilDate(lastDay).month &&
        civilDate(firstDay).year === civilDate(lastDay).year;
      const title =
        view === "day"
          ? formatLongDate(anchor)
          : sameMonth
            ? formatMonthTitle(firstDay)
            : formatRangeTitle(firstDay, lastDay);
      return { view, anchor, days, weeks: [], firstDay, lastDay, title };
    }
    case "month": {
      const weeks = monthViewWeeks(anchor, preferences.weekStartsOn, preferences.showWeekends);
      const firstDay = weeks[0]?.[0] ?? anchor;
      const lastDay = weeks.at(-1)?.at(-1) ?? anchor;
      return {
        view,
        anchor,
        days: weeks.flat(),
        weeks,
        firstDay,
        lastDay,
        title: formatMonthTitle(anchor),
      };
    }
    case "agenda": {
      const lastDay = anchor + Math.max(1, agendaDays) - 1;
      return {
        view,
        anchor,
        days: daySpan(anchor, lastDay),
        weeks: [],
        firstDay: anchor,
        lastDay,
        title: formatMonthTitle(anchor),
      };
    }
  }
}

/** The week chunks covering a range in the view's zone. */
export function rangeWeeks(range: Pick<CalendarRange, "firstDay" | "lastDay">, timeZone: string) {
  return chunkWeeksForDays(range.firstDay, range.lastDay, timeZone);
}

/** The chunks of the previous and next page, minus those already shown, to prefetch. */
export function neighbourWeeks(
  view: CalendarViewKind,
  anchor: DayNumber,
  preferences: RangePreferences,
  timeZone: string,
  shown: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const visible = new Set(shown);
  const weeks = new Set<string>();
  for (const direction of [-1, 1] as const) {
    const range = calendarRange(
      view,
      stepAnchor(view, anchor, direction, preferences),
      preferences,
    );
    for (const week of rangeWeeks(range, timeZone)) {
      if (!visible.has(week)) weeks.add(week);
    }
  }
  return [...weeks].sort();
}

export { stepAnchor };

/**
 * The instances to draw: hidden calendars left out (the server stops sending them, this covers
 * the moment until it does) and declined invitations only when the user wants them.
 */
export function shownInstances(
  instances: ReadonlyArray<CalendarEventInstance>,
  hiddenCalendarIds: ReadonlySet<string>,
  showDeclined: boolean,
): ReadonlyArray<CalendarEventInstance> {
  if (hiddenCalendarIds.size === 0 && showDeclined) return instances;
  const shown = instances.filter(
    (instance) =>
      !hiddenCalendarIds.has(instance.calendarId) &&
      (showDeclined || instance.response !== "declined"),
  );
  return shown.length === instances.length ? instances : shown;
}

/** Ids of hidden calendars as a sorted, comma-joined key, for stable memoization. */
export function hiddenCalendarKey(calendars: ReadonlyArray<Calendar>): string {
  return calendars
    .filter((calendar) => !calendar.visible)
    .map((calendar) => calendar.calendarId)
    .sort()
    .join(",");
}

/** The calendar new events go to: the preference, else the first writable primary calendar. */
export function defaultCalendarId(
  calendars: ReadonlyArray<Calendar>,
  preferred: string | null,
): string | null {
  const writable = calendars.filter(
    (calendar) => calendar.accessRole === "owner" || calendar.accessRole === "writer",
  );
  if (preferred !== null && writable.some((calendar) => calendar.calendarId === preferred)) {
    return preferred;
  }
  return (
    writable.find((calendar) => calendar.primary && calendar.visible)?.calendarId ??
    writable.find((calendar) => calendar.visible)?.calendarId ??
    writable[0]?.calendarId ??
    null
  );
}

/**
 * Where `C` puts a new event: the next half hour when the day is today, the start of working
 * hours on another day; `minutes` long.
 */
export function defaultDraft(options: {
  readonly day: DayNumber;
  readonly today: DayNumber;
  readonly now: number;
  readonly timeZone: string;
  readonly minutes: number;
  readonly workingStart: number;
  readonly calendarId: string | null;
}): { start: number; end: number; allDay: false; calendarId: string | null } {
  const startMinutes =
    options.day === options.today
      ? Math.min(
          Math.ceil((toZoned(options.now, options.timeZone).minutes + 1) / 30) * 30,
          23 * 60 + 30,
        )
      : options.workingStart;
  const start = fromZoned(options.day, startMinutes, options.timeZone);
  return {
    start,
    end: start + options.minutes * MINUTE_MS,
    allDay: false,
    calendarId: options.calendarId,
  };
}
