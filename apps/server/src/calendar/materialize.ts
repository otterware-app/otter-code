/**
 * Turns a series (a recurring master and its exceptions) or a single event into the occurrence
 * rows views read. Pure: the service loads the rows, calls this, and diffs the result against
 * what `calendar_instances` holds.
 *
 * Google's rules: occurrences come from the master's recurrence in its own zone; an exception
 * (keyed by its original start) replaces the occurrence it was generated from and shows at its
 * own time; a cancelled exception removes it; a cancelled master removes the whole series.
 * Exceptions past the end of a series (after a "this and following" split) are not shown.
 *
 * @module materialize
 */
import type { CalendarAccessRole } from "@t3tools/contracts";
import {
  expandRecurrence,
  occurrenceId,
  recurrenceEnd,
  type RecurrenceSeries,
} from "@t3tools/shared/calendar/recurrence";

import {
  displayFields,
  eventKind,
  eventTimes,
  instanceRow,
  originalStartOf,
  type EventTimes,
  type InstanceRow,
} from "./eventModel.ts";
import type { RemoteEvent } from "./providers/CalendarProvider.ts";

/** Occurrences one series may produce in one materialization, against runaway rules. */
const MAX_OCCURRENCES = 20_000;

export interface SeriesInput {
  readonly calendarId: string;
  /** The master's id, or the single event's own id. */
  readonly key: string;
  /** The event stored under `key`, if any (a master or a single event). */
  readonly master: RemoteEvent | undefined;
  /** Stored events whose `recurringEventId` is `key`. */
  readonly exceptions: ReadonlyArray<RemoteEvent>;
  readonly role: CalendarAccessRole;
  /** The calendar's zone, for events that name none. */
  readonly zone: string;
  /** Materialized range of the calendar: occurrences overlapping [start, end). */
  readonly horizon: { readonly start: number; readonly end: number };
}

export function recurrenceSeriesOf(master: RemoteEvent, times: EventTimes): RecurrenceSeries {
  return {
    start: times.start,
    end: times.end,
    allDay: times.allDay,
    timeZone: times.timeZone,
    recurrence: master.recurrence ?? [],
  };
}

export function materializeSeries(input: SeriesInput): Array<InstanceRow> {
  const { calendarId, key, master, role, zone } = input;
  const rows: Array<InstanceRow> = [];
  if (master !== undefined && master.status === "cancelled") return rows;

  const masterTimes = master === undefined ? null : eventTimes(master, zone);
  if (master !== undefined && eventKind(master) === "single") {
    if (masterTimes !== null) {
      rows.push(
        instanceRow(
          calendarId,
          master.id,
          key,
          null,
          masterTimes.start,
          masterTimes.end,
          masterTimes.allDay,
          displayFields(master, role),
        ),
      );
    }
    return rows;
  }

  // The last start the series can have; exceptions after it belong to a truncated part.
  let lastStart: number | null = null;
  if (master !== undefined && masterTimes !== null) {
    const series = recurrenceSeriesOf(master, masterTimes);
    const end = recurrenceEnd(series);
    lastStart = end === null ? null : end - (masterTimes.end - masterTimes.start);
    const replaced = new Set<number>();
    for (const exception of input.exceptions) {
      const original = originalStartOf(exception, masterTimes.timeZone);
      if (original !== null) replaced.add(original);
    }
    const fields = displayFields(master, role);
    for (const occurrence of expandRecurrence(
      series,
      input.horizon.start,
      input.horizon.end,
      MAX_OCCURRENCES,
    )) {
      if (replaced.has(occurrence.start)) continue;
      rows.push(
        instanceRow(
          calendarId,
          occurrenceId(key, occurrence.start, masterTimes.allDay),
          key,
          key,
          occurrence.start,
          occurrence.end,
          masterTimes.allDay,
          fields,
        ),
      );
    }
  }

  const exceptionZone = masterTimes?.timeZone ?? zone;
  for (const exception of input.exceptions) {
    if (exception.status === "cancelled") continue;
    const times = eventTimes(exception, exceptionZone);
    if (times === null) continue;
    const original = originalStartOf(exception, exceptionZone);
    if (lastStart !== null && original !== null && original > lastStart) continue;
    rows.push(
      instanceRow(
        calendarId,
        exception.id,
        key,
        key,
        times.start,
        times.end,
        times.allDay,
        displayFields(exception, role),
      ),
    );
  }
  return rows;
}

/** The series key an event belongs to. */
export function seriesKeyOf(event: RemoteEvent): string {
  return event.recurringEventId ?? event.id;
}
