/**
 * Pure pointer math for the calendar grids: viewport coordinates to (day, minute) slots with
 * geometry cached at drag start, and the event times a gesture proposes. No DOM access, so the
 * gesture controller calls these per frame and tests call them directly.
 *
 * Days are visible day indices (`days[index]` is the civil day), so hidden weekends are simply
 * skipped. Timed results are instants from wall-clock times in the view's zone; all-day results
 * are UTC-midnight dates, end exclusive.
 */
import type { CalendarEventInstance } from "@t3tools/contracts";
import {
  DAY_MS,
  MINUTE_MS,
  type DayNumber,
  dayOfUtcMidnight,
  fromZoned,
  toZoned,
  zonedDay,
} from "@t3tools/shared/calendar/time";

export interface DropResult {
  readonly start: number;
  readonly end: number;
  readonly allDay: boolean;
}

function snapRound(minutes: number, step: number): number {
  return Math.round(minutes / step) * step;
}

function snapFloor(minutes: number, step: number): number {
  return Math.floor(minutes / step) * step;
}

function snapCeil(minutes: number, step: number): number {
  return Math.ceil(minutes / step) * step;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

// ── Time grid hit testing ────────────────────────────────────────────

/** Time grid geometry in viewport pixels, measured once when a gesture starts. */
export interface TimeGridGeometry {
  /** Left edge of the first day column. */
  readonly columnsLeft: number;
  readonly columnWidth: number;
  readonly dayCount: number;
  /** Viewport y of 00:00 when `scrollTop` was `scrollTop0`. */
  readonly gridTop: number;
  readonly scrollTop0: number;
  readonly pxPerMinute: number;
  /** Bottom of the sticky header (day names and all-day lane): above it is the all-day zone. */
  readonly headerBottom: number;
  /** Bottom of the scroll viewport. */
  readonly viewBottom: number;
}

export interface GridHit {
  readonly zone: "timed" | "allDay";
  readonly dayIndex: number;
  /** Unsnapped minutes after midnight, 0–1440 (0 in the all-day zone). */
  readonly minutes: number;
}

export function dayIndexAt(x: number, left: number, width: number, count: number): number {
  return clamp(Math.floor((x - left) / width), 0, count - 1);
}

/** The slot under a viewport point. `forceTimed` keeps timed gestures out of the all-day lane. */
export function hitTimeGrid(
  geometry: TimeGridGeometry,
  x: number,
  y: number,
  scrollTop: number,
  forceTimed = false,
): GridHit {
  const dayIndex = dayIndexAt(x, geometry.columnsLeft, geometry.columnWidth, geometry.dayCount);
  if (!forceTimed && y < geometry.headerBottom) return { zone: "allDay", dayIndex, minutes: 0 };
  const top = geometry.gridTop - (scrollTop - geometry.scrollTop0);
  const clampedY = clamp(y, geometry.headerBottom, geometry.viewBottom);
  return {
    zone: "timed",
    dayIndex,
    minutes: clamp((clampedY - top) / geometry.pxPerMinute, 0, 1440),
  };
}

/**
 * The resize edge a press hits in an event's rect: the top or bottom band of a timed block, or
 * the end of a bar. Bands are 6 px (12–14 px for touch), at most a third of the event.
 */
export function resizeEdge(
  rect: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
  },
  x: number,
  y: number,
  options: {
    readonly vertical: boolean;
    readonly start: boolean;
    readonly end: boolean;
    readonly coarse: boolean;
  },
): "start" | "end" | null {
  if (options.vertical) {
    const band = Math.min(options.coarse ? 12 : 6, (rect.bottom - rect.top) / 3);
    if (options.end && rect.bottom - y <= band) return "end";
    if (options.start && y - rect.top <= band) return "start";
    return null;
  }
  const band = Math.min(options.coarse ? 14 : 6, (rect.right - rect.left) / 3);
  return options.end && rect.right - x <= band ? "end" : null;
}

// ── Proposed times ───────────────────────────────────────────────────

function instantAt(dayMinutes: number, zone: string): number {
  const day = Math.floor(dayMinutes / 1440);
  return fromZoned(day, dayMinutes - day * 1440, zone);
}

/** A timed slot of `minutes` starting at the snapped pointer time (a click on empty space). */
export function clickSlot(
  days: ReadonlyArray<DayNumber>,
  zone: string,
  hit: GridHit,
  step: number,
  minutes: number,
): DropResult {
  const start = clamp(snapFloor(hit.minutes, step), 0, 1440 - step);
  const startMs = fromZoned(days[hit.dayIndex]!, start, zone);
  return { start: startMs, end: startMs + minutes * MINUTE_MS, allDay: false };
}

/** Drawing on empty grid space from `anchor` to `current`, possibly across days. */
export function createTimed(
  days: ReadonlyArray<DayNumber>,
  zone: string,
  anchor: GridHit,
  current: GridHit,
  step: number,
): DropResult {
  const anchorStart = days[anchor.dayIndex]! * 1440 + snapFloor(anchor.minutes, step);
  const currentDay = days[current.dayIndex]! * 1440;
  const at = currentDay + current.minutes;
  let start: number;
  let end: number;
  if (at >= anchorStart) {
    start = anchorStart;
    end = Math.max(anchorStart + step, currentDay + snapCeil(current.minutes, step));
  } else {
    start = currentDay + snapFloor(current.minutes, step);
    end = anchorStart + step;
  }
  return { start: instantAt(start, zone), end: instantAt(end, zone), allDay: false };
}

/** Drawing across days in the all-day lane or month grid: all-day, both ends inclusive. */
export function createAllDay(firstDay: DayNumber, lastDay: DayNumber): DropResult {
  const from = Math.min(firstDay, lastDay);
  const to = Math.max(firstDay, lastDay);
  return { start: from * DAY_MS, end: (to + 1) * DAY_MS, allDay: true };
}

/**
 * Moving a timed event within the grid. The block keeps the pointer's grab offset and its start
 * snaps to the grid (so an event at 10:07 lands on 10:00 or 10:15); the real duration is kept.
 * A block grabbed on its first day stays inside the pointer's day column.
 */
export function moveTimed(
  days: ReadonlyArray<DayNumber>,
  zone: string,
  instance: CalendarEventInstance,
  grab: GridHit,
  current: GridHit,
  step: number,
): DropResult {
  const original = toZoned(instance.start, zone);
  const grabDay = days[grab.dayIndex]!;
  const currentDay = days[current.dayIndex]!;
  let start =
    (original.day + currentDay - grabDay) * 1440 +
    original.minutes +
    (current.minutes - grab.minutes);
  start = snapRound(start, step);
  if (original.day === grabDay) {
    start = clamp(start, currentDay * 1440, currentDay * 1440 + 1440 - step);
  }
  const startMs = instantAt(start, zone);
  return { start: startMs, end: startMs + (instance.end - instance.start), allDay: false };
}

/** Dropping an all-day event (or a long timed one) into the grid at the pointer's time. */
export function moveIntoGrid(
  days: ReadonlyArray<DayNumber>,
  zone: string,
  instance: CalendarEventInstance,
  current: GridHit,
  step: number,
  defaultMinutes: number,
): DropResult {
  const minutes = clamp(snapRound(current.minutes, step), 0, 1440 - step);
  const start = fromZoned(days[current.dayIndex]!, minutes, zone);
  const length =
    instance.allDay === true ? defaultMinutes * MINUTE_MS : instance.end - instance.start;
  return { start, end: start + length, allDay: false };
}

/** Dropping a timed event into the all-day lane: a one-day all-day event on that date. */
export function moveIntoAllDay(day: DayNumber): DropResult {
  return { start: day * DAY_MS, end: (day + 1) * DAY_MS, allDay: true };
}

/**
 * Shifts an event by whole days, keeping its time of day (month moves, lane moves of long
 * timed events, keyboard day moves).
 */
export function shiftDays(
  instance: CalendarEventInstance,
  zone: string,
  dayDelta: number,
): DropResult {
  if (instance.allDay === true) {
    return {
      start: instance.start + dayDelta * DAY_MS,
      end: instance.end + dayDelta * DAY_MS,
      allDay: true,
    };
  }
  const start = toZoned(instance.start, zone);
  const end = toZoned(instance.end, zone);
  return {
    start: fromZoned(start.day + dayDelta, start.minutes, zone),
    end: fromZoned(end.day + dayDelta, end.minutes, zone),
    allDay: false,
  };
}

/** Dragging a timed event's start or end edge to the pointer's snapped time. */
export function resizeTimed(
  days: ReadonlyArray<DayNumber>,
  zone: string,
  instance: CalendarEventInstance,
  edge: "start" | "end",
  current: GridHit,
  step: number,
): DropResult {
  const at = fromZoned(days[current.dayIndex]!, snapRound(current.minutes, step), zone);
  if (edge === "end") {
    return {
      start: instance.start,
      end: Math.max(at, instance.start + step * MINUTE_MS),
      allDay: false,
    };
  }
  return { start: Math.min(at, instance.end - step * MINUTE_MS), end: instance.end, allDay: false };
}

/** Dragging an all-day event's end to a day (inclusive); at least one day long. */
export function resizeAllDayEnd(instance: CalendarEventInstance, lastDay: DayNumber): DropResult {
  const firstDay = dayOfUtcMidnight(instance.start);
  return { start: instance.start, end: (Math.max(firstDay, lastDay) + 1) * DAY_MS, allDay: true };
}

// ── Where a proposal is drawn ────────────────────────────────────────

/** Index of the first visible day >= `day`. */
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

/** Local day range [first, last] of a result. */
export function resultDays(
  result: DropResult,
  zone: string,
): { readonly first: DayNumber; readonly last: DayNumber } {
  if (result.allDay) {
    const first = dayOfUtcMidnight(result.start);
    return { first, last: Math.max(first, dayOfUtcMidnight(result.end) - 1) };
  }
  const first = zonedDay(result.start, zone);
  return { first, last: Math.max(first, zonedDay(Math.max(result.start, result.end - 1), zone)) };
}

/** Visible day indices [startIndex, endIndex] a result covers, or null when none is visible. */
export function visibleSpan(
  days: ReadonlyArray<DayNumber>,
  first: DayNumber,
  last: DayNumber,
): { readonly startIndex: number; readonly endIndex: number } | null {
  const startIndex = lowerBound(days, first);
  const endIndex = lowerBound(days, last + 1) - 1;
  if (startIndex >= days.length || endIndex < startIndex) return null;
  return { startIndex, endIndex };
}

export interface GhostSegment {
  readonly dayIndex: number;
  readonly startMinutes: number;
  readonly endMinutes: number;
}

/** A timed result as per-column segments, by wall-clock minutes. */
export function timedGhostSegments(
  days: ReadonlyArray<DayNumber>,
  zone: string,
  result: DropResult,
): GhostSegment[] {
  const start = toZoned(result.start, zone);
  const end = toZoned(result.end, zone);
  const segments: GhostSegment[] = [];
  for (let index = lowerBound(days, start.day); index < days.length; index++) {
    const day = days[index]!;
    if (day > end.day || (day === end.day && end.minutes === 0 && day !== start.day)) break;
    const from = day === start.day ? start.minutes : 0;
    const to = day === end.day ? Math.max(end.minutes, from) : 1440;
    segments.push({ dayIndex: index, startMinutes: from, endMinutes: to });
  }
  return segments;
}

/** Whether a gesture's proposal differs from where the event already is. */
export function changesInstance(instance: CalendarEventInstance, result: DropResult): boolean {
  return (
    result.start !== instance.start ||
    result.end !== instance.end ||
    result.allDay !== (instance.allDay === true)
  );
}

// ── Month grid hit testing ───────────────────────────────────────────

export interface MonthGeometry {
  readonly left: number;
  readonly top: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly columns: number;
  readonly rows: number;
}

/** Index into the flattened month days of the cell under a viewport point. */
export function hitMonth(geometry: MonthGeometry, x: number, y: number): number {
  const column = dayIndexAt(x, geometry.left, geometry.cellWidth, geometry.columns);
  const row = dayIndexAt(y, geometry.top, geometry.cellHeight, geometry.rows);
  return row * geometry.columns + column;
}
