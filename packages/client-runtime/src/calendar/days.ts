/**
 * Which days a calendar view shows, and which events fall on them.
 *
 * Views work in local days of one zone (`DayNumber`s). Timed events become per-day segments
 * positioned by wall-clock minutes (a 23 h or 25 h DST day still draws 24 hour rows, like
 * Google Calendar); all-day events and timed events of 24 h or more become spans over the
 * visible days, drawn in the all-day lane or as month bars.
 *
 * `DayBucketCache` reuses earlier per-day arrays when a day's segments did not change, so
 * memoized columns and their layouts survive unrelated updates and navigation.
 *
 * @module calendar/days
 */
import type { CalendarEventInstance, CalendarPreferences } from "@t3tools/contracts";
import {
  DAY_MS,
  MINUTE_MS,
  type DayNumber,
  addMonths,
  civilDate,
  dayNumber,
  dayOfUtcMidnight,
  daysInMonth,
  startOfWeek,
  startOfZonedDay,
  toZoned,
  weekday,
  zonedDay,
} from "@t3tools/shared/calendar/time";

// ── Visible days ─────────────────────────────────────────────────────

export type CalendarViewKind = "day" | "week" | "custom" | "month" | "agenda";

function isWeekend(day: DayNumber): boolean {
  const dow = weekday(day);
  return dow === 0 || dow === 6;
}

type DayPreferences = Pick<CalendarPreferences, "weekStartsOn" | "customDays" | "showWeekends">;

/** The days of the week containing `anchor`, without Saturday and Sunday when weekends are hidden. */
export function weekViewDays(
  anchor: DayNumber,
  weekStartsOn: number,
  showWeekends: boolean,
): DayNumber[] {
  const first = startOfWeek(anchor, weekStartsOn);
  const days: DayNumber[] = [];
  for (let day = first; day < first + 7; day++) {
    if (showWeekends || !isWeekend(day)) days.push(day);
  }
  return days;
}

/**
 * `count` days starting at `anchor`. Without weekends, weekend days are skipped and do not count
 * (an anchor on a weekend starts at the next Monday).
 */
export function customViewDays(
  anchor: DayNumber,
  count: number,
  showWeekends: boolean,
): DayNumber[] {
  const days: DayNumber[] = [];
  for (let day = anchor; days.length < count; day++) {
    if (showWeekends || !isWeekend(day)) days.push(day);
  }
  return days;
}

/**
 * The week rows of the month containing `anchor`: every week touching the month, at least 5 rows
 * (a 4-week February gets the next week too). Rows skip weekends when they are hidden.
 */
export function monthViewWeeks(
  anchor: DayNumber,
  weekStartsOn: number,
  showWeekends: boolean,
): DayNumber[][] {
  const { year, month } = civilDate(anchor);
  const first = dayNumber(year, month, 1);
  const last = first + daysInMonth(year, month) - 1;
  const gridStart = startOfWeek(first, weekStartsOn);
  const rows = Math.max(5, Math.ceil((last - gridStart + 1) / 7));
  const weeks: DayNumber[][] = [];
  for (let row = 0; row < rows; row++) {
    const week: DayNumber[] = [];
    for (let day = gridStart + row * 7; day < gridStart + row * 7 + 7; day++) {
      if (showWeekends || !isWeekend(day)) week.push(day);
    }
    weeks.push(week);
  }
  return weeks;
}

/** The days a time-grid view (day, week, custom) shows around `anchor`. */
export function timeGridDays(
  view: "day" | "week" | "custom",
  anchor: DayNumber,
  preferences: DayPreferences,
): DayNumber[] {
  switch (view) {
    case "day":
      return [anchor];
    case "week":
      return weekViewDays(anchor, preferences.weekStartsOn, preferences.showWeekends);
    case "custom":
      return customViewDays(anchor, preferences.customDays, preferences.showWeekends);
  }
}

/**
 * The anchor after moving one page forward (`direction` 1) or back (-1). Day views skip hidden
 * weekends; custom views move by their visible day count.
 */
export function stepAnchor(
  view: CalendarViewKind,
  anchor: DayNumber,
  direction: 1 | -1,
  preferences: DayPreferences,
): DayNumber {
  switch (view) {
    case "day": {
      let day = anchor + direction;
      while (!preferences.showWeekends && isWeekend(day)) day += direction;
      return day;
    }
    case "week":
    case "agenda":
      return anchor + 7 * direction;
    case "custom": {
      if (direction === 1) {
        const days = customViewDays(anchor, preferences.customDays, preferences.showWeekends);
        return customViewDays(days[days.length - 1]! + 1, 1, preferences.showWeekends)[0]!;
      }
      let day = anchor;
      for (let moved = 0; moved < preferences.customDays;) {
        day--;
        if (preferences.showWeekends || !isWeekend(day)) moved++;
      }
      return day;
    }
    case "month":
      return addMonths(anchor, direction);
  }
}

// ── Bucketing ────────────────────────────────────────────────────────

/** A timed event's part within one local day. */
export interface TimedSegment {
  /** `calendarEventKey` of the instance. */
  readonly key: string;
  readonly instance: CalendarEventInstance;
  /** Wall-clock minutes after local midnight, 0–1440. */
  readonly startMinutes: number;
  /** Wall-clock minutes after local midnight, `startMinutes`–1440. */
  readonly endMinutes: number;
  /** The event started on an earlier day. */
  readonly continuesBefore: boolean;
  /** The event ends on a later day. */
  readonly continuesAfter: boolean;
}

export type SpanKind =
  /** An all-day event. */
  | "allDay"
  /** A timed event of 24 hours or more. */
  | "timedSpan"
  /** A shorter timed event, placed on its first visible day (month rows only). */
  | "timed";

/** An event across a run of visible days, as indices into the visible day list. */
export interface SpanItem {
  readonly key: string;
  readonly instance: CalendarEventInstance;
  readonly kind: SpanKind;
  /** First visible day index covered (inclusive). */
  readonly startIndex: number;
  /** Last visible day index covered (inclusive). */
  readonly endIndex: number;
  /** The event starts before `startIndex`'s day. */
  readonly continuesBefore: boolean;
  /** The event ends after `endIndex`'s day. */
  readonly continuesAfter: boolean;
}

export interface DayBuckets {
  readonly days: ReadonlyArray<DayNumber>;
  readonly timeZone: string;
  /** Timed segments per visible day, sorted by start, then longer first, then key. */
  readonly timed: ReadonlyArray<ReadonlyArray<TimedSegment>>;
  /** All-day events and timed events of 24 h or more, sorted for level packing. */
  readonly spans: ReadonlyArray<SpanItem>;
}

export function instanceKey(instance: CalendarEventInstance): string {
  return `${instance.calendarId}/${instance.eventId}`;
}

/** Local day range [firstDay, lastDay] an instance covers, and whether it is drawn as a span. */
export function instanceDays(
  instance: CalendarEventInstance,
  timeZone: string,
): { readonly firstDay: DayNumber; readonly lastDay: DayNumber; readonly span: SpanKind | null } {
  if (instance.allDay === true) {
    const firstDay = dayOfUtcMidnight(instance.start);
    const lastDay = Math.max(firstDay, dayOfUtcMidnight(instance.end) - 1);
    return { firstDay, lastDay, span: "allDay" };
  }
  const firstDay = zonedDay(instance.start, timeZone);
  const end = Math.max(instance.end, instance.start + 1);
  const lastDay = Math.max(firstDay, zonedDay(end - 1, timeZone));
  return {
    firstDay,
    lastDay,
    span: instance.end - instance.start >= DAY_MS ? "timedSpan" : null,
  };
}

/** Index of the first visible day >= `day` (days are ascending), or `days.length`. */
function lowerBound(days: ReadonlyArray<DayNumber>, day: DayNumber): number {
  let low = 0;
  let high = days.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (days[mid]! < day) low = mid + 1;
    else high = mid;
  }
  return low;
}

function compareTimed(a: TimedSegment, b: TimedSegment): number {
  return (
    a.startMinutes - b.startMinutes ||
    b.endMinutes - a.endMinutes ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

const SPAN_KIND_RANK: Record<SpanKind, number> = { allDay: 0, timedSpan: 1, timed: 2 };

/**
 * Order for level packing: earlier first, longer first, all-day before timed, then by start
 * time, title and key, so the output is stable.
 */
export function compareSpans(a: SpanItem, b: SpanItem): number {
  return (
    a.startIndex - b.startIndex ||
    b.endIndex - b.startIndex - (a.endIndex - a.startIndex) ||
    SPAN_KIND_RANK[a.kind] - SPAN_KIND_RANK[b.kind] ||
    a.instance.start - b.instance.start ||
    b.instance.end - a.instance.end ||
    (a.instance.title < b.instance.title ? -1 : a.instance.title > b.instance.title ? 1 : 0) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/**
 * Buckets instances into the visible local days of `timeZone`. `days` must be ascending (gaps
 * for hidden weekends are fine). Timed events under 24 h are clipped to each local day they
 * touch; the rest become spans.
 */
export function bucketInstances(
  instances: ReadonlyArray<CalendarEventInstance>,
  days: ReadonlyArray<DayNumber>,
  timeZone: string,
  showDeclined = true,
): DayBuckets {
  const timed: TimedSegment[][] = days.map(() => []);
  const spans: SpanItem[] = [];
  if (days.length > 0) {
    const firstVisible = days[0]!;
    const lastVisible = days[days.length - 1]!;
    for (const instance of instances) {
      if (!showDeclined && instance.response === "declined") continue;
      const { firstDay, lastDay, span } = instanceDays(instance, timeZone);
      if (lastDay < firstVisible || firstDay > lastVisible) continue;
      const startIndex = lowerBound(days, firstDay);
      if (startIndex >= days.length || days[startIndex]! > lastDay) continue;
      const key = instanceKey(instance);
      if (span !== null) {
        let endIndex = lowerBound(days, lastDay + 1) - 1;
        if (endIndex < startIndex) endIndex = startIndex;
        spans.push({
          key,
          instance,
          kind: span,
          startIndex,
          endIndex,
          continuesBefore: firstDay < days[startIndex]!,
          continuesAfter: lastDay > days[endIndex]!,
        });
        continue;
      }
      for (let index = startIndex; index < days.length && days[index]! <= lastDay; index++) {
        timed[index]!.push(timedSegment(instance, key, days[index]!, firstDay, lastDay, timeZone));
      }
    }
  }
  for (const bucket of timed) bucket.sort(compareTimed);
  spans.sort(compareSpans);
  return { days, timeZone, timed, spans };
}

function timedSegment(
  instance: CalendarEventInstance,
  key: string,
  day: DayNumber,
  firstDay: DayNumber,
  lastDay: DayNumber,
  timeZone: string,
): TimedSegment {
  const continuesBefore = day > firstDay;
  const continuesAfter = day < lastDay;
  const startMinutes = continuesBefore ? 0 : toZoned(instance.start, timeZone).minutes;
  let endMinutes = 1440;
  if (!continuesAfter) {
    const end = toZoned(instance.end, timeZone);
    if (end.day === day) endMinutes = end.minutes;
  }
  if (endMinutes < startMinutes) {
    // Inside a fall-back overlap (01:30 EDT to 01:10 EST) the wall clock runs backwards: keep
    // the real length so the block stays visible and clickable.
    const clippedStart = continuesBefore ? startOfZonedDay(day, timeZone) : instance.start;
    endMinutes = Math.min(1440, startMinutes + (instance.end - clippedStart) / MINUTE_MS);
  }
  return { key, instance, startMinutes, endMinutes, continuesBefore, continuesAfter };
}

// ── Structural sharing ───────────────────────────────────────────────

/** Whether two instances carry the same data (instances are flat records of primitives). */
export function sameInstance(a: CalendarEventInstance, b: CalendarEventInstance): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a) as Array<keyof CalendarEventInstance>;
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function sameSegment(a: TimedSegment, b: TimedSegment): boolean {
  return (
    a === b ||
    (a.key === b.key &&
      a.startMinutes === b.startMinutes &&
      a.endMinutes === b.endMinutes &&
      a.continuesBefore === b.continuesBefore &&
      a.continuesAfter === b.continuesAfter &&
      sameInstance(a.instance, b.instance))
  );
}

function sameSpan(a: SpanItem, b: SpanItem): boolean {
  return (
    a === b ||
    (a.key === b.key &&
      a.kind === b.kind &&
      a.startIndex === b.startIndex &&
      a.endIndex === b.endIndex &&
      a.continuesBefore === b.continuesBefore &&
      a.continuesAfter === b.continuesAfter &&
      sameInstance(a.instance, b.instance))
  );
}

/** `previous` when both lists hold equal items in the same order, else `next`. */
export function reuseList<T>(
  previous: ReadonlyArray<T> | undefined,
  next: ReadonlyArray<T>,
  same: (a: T, b: T) => boolean,
): ReadonlyArray<T> {
  if (previous === undefined || previous.length !== next.length) return next;
  for (let index = 0; index < next.length; index++) {
    if (!same(previous[index]!, next[index]!)) return next;
  }
  return previous;
}

/**
 * `previous` when both lists hold equal items; otherwise `next`, with every item equal to a
 * previous one of the same key replaced by that previous object. Unchanged events keep their
 * identity (and their memoized elements) when something else in the list changes.
 */
export function reuseItems<T extends { readonly key: string }>(
  previous: ReadonlyArray<T> | undefined,
  next: ReadonlyArray<T>,
  same: (a: T, b: T) => boolean,
): ReadonlyArray<T> {
  if (previous === undefined) return next;
  if (reuseList(previous, next, same) === previous) return previous;
  if (previous.length === 0) return next;
  const byKey = new Map<string, T>();
  for (const item of previous) byKey.set(item.key, item);
  return next.map((item) => {
    const old = byKey.get(item.key);
    return old !== undefined && same(old, item) ? old : item;
  });
}

/** `reuseItems` for span lists (all-day lanes, month rows). */
export function reuseSpans(
  previous: ReadonlyArray<SpanItem> | undefined,
  next: ReadonlyArray<SpanItem>,
): ReadonlyArray<SpanItem> {
  return reuseItems(previous, next, sameSpan);
}

/**
 * Keeps per-day buckets across calls so navigating back to a week, or an update elsewhere,
 * hands columns the same arrays they had (and their memoized layouts stay valid).
 */
export class DayBucketCache {
  private readonly byDay = new Map<DayNumber, ReadonlyArray<TimedSegment>>();
  private zone = "";
  private last: DayBuckets | null = null;

  private readonly maxDays: number;

  constructor(maxDays = 120) {
    this.maxDays = maxDays;
  }

  bucket(
    instances: ReadonlyArray<CalendarEventInstance>,
    days: ReadonlyArray<DayNumber>,
    timeZone: string,
    showDeclined = true,
  ): DayBuckets {
    if (timeZone !== this.zone) {
      this.byDay.clear();
      this.zone = timeZone;
      this.last = null;
    }
    const fresh = bucketInstances(instances, days, timeZone, showDeclined);
    let unchanged =
      this.last !== null &&
      this.last.days.length === days.length &&
      this.last.days.every((day, index) => day === days[index]);
    const timed = fresh.timed.map((bucket, index) => {
      const day = days[index]!;
      const reused = reuseItems(this.byDay.get(day), bucket, sameSegment);
      this.byDay.delete(day);
      this.byDay.set(day, reused);
      if (unchanged && reused !== this.last!.timed[index]) unchanged = false;
      return reused;
    });
    while (this.byDay.size > this.maxDays) {
      const oldest = this.byDay.keys().next().value;
      if (oldest === undefined) break;
      this.byDay.delete(oldest);
    }
    const spans =
      this.last !== null ? reuseItems(this.last.spans, fresh.spans, sameSpan) : fresh.spans;
    if (unchanged && spans === this.last!.spans) return this.last!;
    this.last = { days: fresh.days, timeZone, timed, spans };
    return this.last;
  }
}

/** Spans clipped to visible indices [from, to), re-indexed from 0 (for month week rows). */
export function sliceSpans(spans: ReadonlyArray<SpanItem>, from: number, to: number): SpanItem[] {
  const result: SpanItem[] = [];
  for (const span of spans) {
    if (span.endIndex < from || span.startIndex >= to) continue;
    const startIndex = Math.max(span.startIndex, from);
    const endIndex = Math.min(span.endIndex, to - 1);
    result.push({
      ...span,
      startIndex: startIndex - from,
      endIndex: endIndex - from,
      continuesBefore: span.continuesBefore || startIndex > span.startIndex,
      continuesAfter: span.continuesAfter || endIndex < span.endIndex,
    });
  }
  return result;
}
