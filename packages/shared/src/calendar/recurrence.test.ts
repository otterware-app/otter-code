import { describe, expect, it } from "vite-plus/test";

import {
  buildRecurrenceRule,
  describeRecurrence,
  expandRecurrence,
  occurrenceId,
  parseOccurrenceId,
  recurrenceBefore,
  recurrenceEnd,
  recurrenceFrom,
  repeatOptionsOf,
  type RecurrenceSeries,
} from "./recurrence.ts";
import { DAY_MS, dayNumber, formatZonedIso, fromZoned, toZoned } from "./time.ts";

const HOUR = 3_600_000;
const berlin = "Europe/Berlin";

function timed(start: number, rule: Array<string>, zone = berlin, hours = 1): RecurrenceSeries {
  return { start, end: start + hours * HOUR, allDay: false, timeZone: zone, recurrence: rule };
}

const at = (y: number, m: number, d: number, minutes: number, zone = berlin) =>
  fromZoned(dayNumber(y, m, d), minutes, zone);

const isoIn = (zone: string) => (ms: number) => formatZonedIso(ms, zone);

describe("expandRecurrence", () => {
  it("keeps wall-clock time across DST in the series zone", () => {
    const series = timed(at(2026, 3, 23, 540), ["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
    const occurrences = expandRecurrence(series, at(2026, 3, 1, 0), at(2026, 4, 14, 0));
    expect(occurrences.map((o) => isoIn(berlin)(o.start))).toEqual([
      "2026-03-23T09:00:00+01:00",
      "2026-03-30T09:00:00+02:00",
      "2026-04-06T09:00:00+02:00",
      "2026-04-13T09:00:00+02:00",
    ]);
    expect(occurrences.every((o) => o.end - o.start === HOUR)).toBe(true);
  });

  it("jumps to far windows of endless series", () => {
    const series = timed(at(2020, 1, 1, 600), ["RRULE:FREQ=DAILY"]);
    const from = at(2030, 6, 1, 0);
    const occurrences = expandRecurrence(series, from, from + 3 * DAY_MS);
    expect(occurrences.map((o) => isoIn(berlin)(o.start))).toEqual([
      "2030-06-01T10:00:00+02:00",
      "2030-06-02T10:00:00+02:00",
      "2030-06-03T10:00:00+02:00",
    ]);
  });

  it("honours COUNT, UNTIL, INTERVAL and EXDATE", () => {
    const start = at(2026, 10, 1, 540);
    expect(
      expandRecurrence(timed(start, ["RRULE:FREQ=DAILY;COUNT=3"]), start, start + 30 * DAY_MS),
    ).toHaveLength(3);
    const until = timed(start, ["RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261031T235959Z"]);
    expect(
      expandRecurrence(until, start, start + 90 * DAY_MS).map((o) => isoIn(berlin)(o.start)),
    ).toEqual([
      "2026-10-01T09:00:00+02:00",
      "2026-10-15T09:00:00+02:00",
      "2026-10-29T09:00:00+01:00",
    ]);
    const exdate = timed(start, [
      "RRULE:FREQ=DAILY;COUNT=4",
      "EXDATE;TZID=Europe/Berlin:20261002T090000",
    ]);
    expect(
      expandRecurrence(exdate, start, start + 30 * DAY_MS).map((o) => isoIn(berlin)(o.start)),
    ).toEqual([
      "2026-10-01T09:00:00+02:00",
      "2026-10-03T09:00:00+02:00",
      "2026-10-04T09:00:00+02:00",
    ]);
  });

  it("expands monthly ordinals, last weekdays and negative month days", () => {
    const start = at(2026, 1, 13, 600); // second Tuesday of January 2026
    const second = timed(start, ["RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3"]);
    expect(
      expandRecurrence(second, start, start + 400 * DAY_MS).map(
        (o) => toZoned(o.start, berlin).day,
      ),
    ).toEqual([dayNumber(2026, 1, 13), dayNumber(2026, 2, 10), dayNumber(2026, 3, 10)]);
    const lastFriday = timed(at(2026, 1, 30, 600), ["RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3"]);
    expect(
      expandRecurrence(lastFriday, at(2026, 1, 1, 0), at(2026, 12, 31, 0)).map(
        (o) => toZoned(o.start, berlin).day,
      ),
    ).toEqual([dayNumber(2026, 1, 30), dayNumber(2026, 2, 27), dayNumber(2026, 3, 27)]);
    const lastDay = timed(at(2026, 1, 31, 600), ["RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3"]);
    expect(
      expandRecurrence(lastDay, at(2026, 1, 1, 0), at(2026, 12, 31, 0)).map(
        (o) => toZoned(o.start, berlin).day,
      ),
    ).toEqual([dayNumber(2026, 1, 31), dayNumber(2026, 2, 28), dayNumber(2026, 3, 31)]);
    // The 31st skips months without one.
    const thirtyFirst = timed(at(2026, 1, 31, 600), ["RRULE:FREQ=MONTHLY;COUNT=3"]);
    expect(
      expandRecurrence(thirtyFirst, at(2026, 1, 1, 0), at(2026, 12, 31, 0)).map(
        (o) => toZoned(o.start, berlin).day,
      ),
    ).toEqual([dayNumber(2026, 1, 31), dayNumber(2026, 3, 31), dayNumber(2026, 5, 31)]);
  });

  it("expands all-day and yearly series on floating dates", () => {
    const start = dayNumber(2024, 2, 29) * DAY_MS;
    const series: RecurrenceSeries = {
      start,
      end: start + DAY_MS,
      allDay: true,
      timeZone: "UTC",
      recurrence: ["RRULE:FREQ=YEARLY"],
    };
    const occurrences = expandRecurrence(series, start, dayNumber(2033, 1, 1) * DAY_MS);
    expect(occurrences.map((o) => o.start / DAY_MS)).toEqual([
      dayNumber(2024, 2, 29),
      dayNumber(2028, 2, 29),
      dayNumber(2032, 2, 29),
    ]);
  });

  it("includes occurrences that start before the window but overlap it", () => {
    const series = timed(at(2026, 10, 1, 1320), ["RRULE:FREQ=DAILY"], berlin, 4); // 22:00–02:00
    const from = at(2026, 10, 5, 0);
    const occurrences = expandRecurrence(series, from, from + DAY_MS);
    expect(occurrences.map((o) => isoIn(berlin)(o.start))).toEqual([
      "2026-10-04T22:00:00+02:00",
      "2026-10-05T22:00:00+02:00",
    ]);
  });

  it("expands weekday rules in other zones", () => {
    const zone = "America/New_York";
    const series = timed(at(2026, 10, 30, 540, zone), ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"], zone);
    const occurrences = expandRecurrence(
      series,
      at(2026, 10, 30, 0, zone),
      at(2026, 11, 7, 0, zone),
    );
    expect(occurrences.map((o) => isoIn(zone)(o.start))).toEqual([
      "2026-10-30T09:00:00-04:00",
      "2026-11-02T09:00:00-05:00",
      "2026-11-04T09:00:00-05:00",
      "2026-11-06T09:00:00-05:00",
    ]);
  });
});

describe("splitting and ids", () => {
  it("ends the old series before the split and carries COUNT over", () => {
    const start = at(2026, 10, 1, 540);
    const series = timed(start, ["RRULE:FREQ=DAILY;COUNT=10"]);
    const split = at(2026, 10, 5, 540);
    const before = recurrenceBefore(series, split);
    expect(
      expandRecurrence({ ...series, recurrence: before }, start, start + 30 * DAY_MS),
    ).toHaveLength(4);
    expect(recurrenceFrom(series, split)).toEqual(["RRULE:FREQ=DAILY;COUNT=6"]);
    expect(recurrenceEnd({ ...series, recurrence: before })).toBe(split - 1000 + HOUR);
    expect(recurrenceEnd(timed(start, ["RRULE:FREQ=DAILY"]))).toBeNull();
    expect(recurrenceEnd(series)).toBe(at(2026, 10, 10, 540) + HOUR);
  });

  it("formats and parses Google-style instance ids", () => {
    const start = Date.UTC(2026, 9, 1, 7);
    const id = occurrenceId("abc123", start, false);
    expect(id).toBe("abc123_20261001T070000Z");
    expect(parseOccurrenceId(id)).toEqual({ seriesId: "abc123", start, allDay: false });
    expect(occurrenceId("x_y", dayNumber(2026, 10, 1) * DAY_MS, true)).toBe("x_y_20261001");
    expect(parseOccurrenceId("x_y_20261001")?.seriesId).toBe("x_y");
    expect(parseOccurrenceId("plainid")).toBeNull();
  });
});

describe("editor helpers", () => {
  const anchor = { start: at(2026, 10, 13, 600), allDay: false, timeZone: berlin };

  it("builds rules and reads them back", () => {
    const weekly = buildRecurrenceRule({ freq: "WEEKLY", weekdays: [3, 1] }, anchor);
    expect(weekly).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO,WE");
    expect(repeatOptionsOf([weekly], anchor)).toEqual({
      freq: "WEEKLY",
      interval: 1,
      weekdays: [1, 3],
    });
    expect(buildRecurrenceRule({ freq: "MONTHLY", monthlyByWeekday: true }, anchor)).toBe(
      "RRULE:FREQ=MONTHLY;BYDAY=2TU",
    );
    const until = buildRecurrenceRule({ freq: "DAILY", untilDay: dayNumber(2026, 10, 20) }, anchor);
    expect(until).toBe("RRULE:FREQ=DAILY;UNTIL=20261020T215959Z");
    expect(repeatOptionsOf([until], anchor)?.untilDay).toBe(dayNumber(2026, 10, 20));
  });

  it("describes rules in words", () => {
    expect(describeRecurrence(["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"], anchor)).toBe(
      "Every weekday",
    );
    expect(describeRecurrence(["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;COUNT=10"], anchor)).toBe(
      "Every 2 weeks on Friday, 10 times",
    );
    expect(describeRecurrence(["RRULE:FREQ=MONTHLY;BYDAY=-1FR"], anchor)).toBe(
      "Monthly on the last Friday",
    );
    expect(describeRecurrence(["RRULE:FREQ=YEARLY"], anchor)).toBe("Annually on October 13");
    expect(describeRecurrence([], anchor)).toBe("Does not repeat");
  });
});
