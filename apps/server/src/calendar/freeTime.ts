/**
 * Free time across calendars: the gaps between busy instances, optionally inside working
 * hours. All-day events, events marked free and declined invitations do not count as busy.
 *
 * @module freeTime
 */
import { fromZoned, weekday, zonedDay } from "@t3tools/shared/calendar/time";

import { FLAG_ALL_DAY, FLAG_FREE, type InstanceRow } from "./eventModel.ts";

export interface Interval {
  readonly start: number;
  readonly end: number;
}

export interface WorkingHours {
  /** Minutes after midnight. */
  readonly start: number;
  readonly end: number;
  /** 0 = Sunday. */
  readonly days: ReadonlyArray<number>;
}

function isBusy(row: InstanceRow): boolean {
  return (row.flags & (FLAG_ALL_DAY | FLAG_FREE)) === 0 && row.response !== "declined";
}

/** Busy intervals clipped to [start, end), sorted and merged. */
export function mergeBusy(rows: ReadonlyArray<InstanceRow>, range: Interval): Array<Interval> {
  const busy = rows
    .filter(isBusy)
    .map((row) => ({ start: Math.max(row.start, range.start), end: Math.min(row.end, range.end) }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of busy) {
    const last = merged.at(-1);
    if (last !== undefined && interval.start <= last.end)
      last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** The working-hours windows of each working day inside `range`, in `zone`. */
export function workingWindows(
  range: Interval,
  hours: WorkingHours,
  zone: string,
): Array<Interval> {
  const windows: Array<Interval> = [];
  const lastDay = zonedDay(range.end - 1, zone);
  for (let day = zonedDay(range.start, zone); day <= lastDay; day += 1) {
    if (!hours.days.includes(weekday(day))) continue;
    const start = Math.max(range.start, fromZoned(day, hours.start, zone));
    const end = Math.min(range.end, fromZoned(day, hours.end, zone));
    if (end > start) windows.push({ start, end });
  }
  return windows;
}

/** Gaps of at least `minimumMs` inside `windows` that no busy interval covers. */
export function freeSlots(
  windows: ReadonlyArray<Interval>,
  busy: ReadonlyArray<Interval>,
  minimumMs: number,
  limit: number,
): Array<Interval> {
  const slots: Array<Interval> = [];
  let index = 0;
  for (const window of windows) {
    let cursor = window.start;
    while (index < busy.length && busy[index]!.end <= window.start) index += 1;
    let scan = index;
    while (scan < busy.length && busy[scan]!.start < window.end) {
      const interval = busy[scan]!;
      if (interval.start - cursor >= minimumMs) slots.push({ start: cursor, end: interval.start });
      cursor = Math.max(cursor, interval.end);
      scan += 1;
    }
    if (window.end - cursor >= minimumMs) slots.push({ start: cursor, end: window.end });
    if (slots.length >= limit) return slots.slice(0, limit);
  }
  return slots;
}
