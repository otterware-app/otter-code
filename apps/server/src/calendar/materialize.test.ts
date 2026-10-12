import { describe, expect, it } from "@effect/vitest";
import { occurrenceId, recurrenceBefore } from "@t3tools/shared/calendar/recurrence";
import { DAY_MS, fromZoned, parseDayNumber } from "@t3tools/shared/calendar/time";

import { FLAG_ALL_DAY, FLAG_READ_ONLY } from "./eventModel.ts";
import { materializeSeries, recurrenceSeriesOf } from "./materialize.ts";
import type { RemoteEvent } from "./providers/CalendarProvider.ts";

const zone = "Europe/Berlin";
const day = (value: string) => parseDayNumber(value)!;
const at = (date: string, minutes: number) => fromZoned(day(date), minutes, zone);

const standup: RemoteEvent = {
  id: "standup",
  summary: "Standup",
  start: { dateTime: "2026-10-05T09:30:00+02:00", timeZone: zone },
  end: { dateTime: "2026-10-05T09:45:00+02:00", timeZone: zone },
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"],
};

const horizon = { start: day("2026-10-05") * DAY_MS, end: day("2026-10-12") * DAY_MS };

const materialize = (
  master: RemoteEvent | undefined,
  exceptions: ReadonlyArray<RemoteEvent> = [],
) =>
  materializeSeries({
    calendarId: "cal",
    key: "standup",
    master,
    exceptions,
    role: "owner",
    zone,
    horizon,
  });

describe("materializeSeries", () => {
  it("expands a weekday series in its own zone, one row per occurrence", () => {
    const rows = materialize(standup);
    expect(rows.map((row) => row.start)).toEqual(
      ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"].map((date) =>
        at(date, 570),
      ),
    );
    expect(rows[0]).toMatchObject({
      instanceId: occurrenceId("standup", at("2026-10-05", 570), false),
      seriesId: "standup",
      sourceKey: "standup",
      title: "Standup",
      end: at("2026-10-05", 585),
    });
  });

  it("replaces occurrences with exceptions and drops cancelled ones", () => {
    const tuesday = at("2026-10-06", 570);
    const thursday = at("2026-10-08", 570);
    const moved: RemoteEvent = {
      id: occurrenceId("standup", tuesday, false),
      recurringEventId: "standup",
      originalStartTime: { dateTime: "2026-10-06T09:30:00+02:00", timeZone: zone },
      summary: "Standup (moved)",
      start: { dateTime: "2026-10-06T11:00:00+02:00", timeZone: zone },
      end: { dateTime: "2026-10-06T11:15:00+02:00", timeZone: zone },
    };
    const cancelled: RemoteEvent = {
      id: occurrenceId("standup", thursday, false),
      status: "cancelled",
      recurringEventId: "standup",
      originalStartTime: { dateTime: "2026-10-08T07:30:00Z" },
    };
    const rows = materialize(standup, [moved, cancelled]);
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.instanceId === moved.id)).toMatchObject({
      title: "Standup (moved)",
      start: at("2026-10-06", 660),
    });
    expect(rows.some((row) => row.start === thursday)).toBe(false);
  });

  it("hides the whole series when the master is cancelled, and exceptions past a split", () => {
    expect(materialize({ ...standup, status: "cancelled" })).toEqual([]);

    const wednesday = at("2026-10-07", 570);
    const friday = at("2026-10-09", 570);
    const times = {
      start: at("2026-10-05", 570),
      end: at("2026-10-05", 585),
      allDay: false,
      timeZone: zone,
    };
    const truncated: RemoteEvent = {
      ...standup,
      recurrence: recurrenceBefore(recurrenceSeriesOf(standup, times), wednesday),
    };
    const lateException: RemoteEvent = {
      id: occurrenceId("standup", friday, false),
      recurringEventId: "standup",
      originalStartTime: { dateTime: "2026-10-09T09:30:00+02:00", timeZone: zone },
      summary: "Late",
      start: { dateTime: "2026-10-09T10:00:00+02:00", timeZone: zone },
      end: { dateTime: "2026-10-09T10:15:00+02:00", timeZone: zone },
    };
    const rows = materialize(truncated, [lateException]);
    expect(rows.map((row) => row.start)).toEqual([at("2026-10-05", 570), at("2026-10-06", 570)]);
  });

  it("shows invitations to single occurrences without their series", () => {
    const orphan: RemoteEvent = {
      id: "other_20261006T090000Z",
      recurringEventId: "other",
      originalStartTime: { dateTime: "2026-10-06T09:00:00Z" },
      summary: "Guest seat",
      start: { dateTime: "2026-10-06T09:00:00Z" },
      end: { dateTime: "2026-10-06T10:00:00Z" },
      organizer: { email: "someone@example.com" },
      attendees: [{ email: "me@example.com", self: true, responseStatus: "needsAction" }],
    };
    const rows = materializeSeries({
      calendarId: "cal",
      key: "other",
      master: undefined,
      exceptions: [orphan],
      role: "owner",
      zone,
      horizon,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ instanceId: orphan.id, response: "needsAction" });
    expect((rows[0]!.flags & FLAG_READ_ONLY) !== 0).toBe(true);
  });

  it("keeps all-day events as floating dates", () => {
    const trip: RemoteEvent = {
      id: "trip",
      summary: "Trip",
      start: { date: "2026-10-06" },
      end: { date: "2026-10-09" },
    };
    const [row] = materializeSeries({
      calendarId: "cal",
      key: "trip",
      master: trip,
      exceptions: [],
      role: "owner",
      zone,
      horizon,
    });
    expect(row).toMatchObject({
      start: day("2026-10-06") * DAY_MS,
      end: day("2026-10-09") * DAY_MS,
    });
    expect((row!.flags & FLAG_ALL_DAY) !== 0).toBe(true);
  });
});
