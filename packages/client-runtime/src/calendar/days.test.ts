import { describe, expect, it } from "vite-plus/test";
import { formatDayNumber } from "@t3tools/shared/calendar/time";

import {
  DayBucketCache,
  bucketInstances,
  customViewDays,
  monthViewWeeks,
  reuseItems,
  sameInstance,
  sliceSpans,
  stepAnchor,
  timeGridDays,
  weekViewDays,
} from "./days.ts";
import { allDay, day, instance, timed } from "./testFixtures.ts";

const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";
const prefs = { weekStartsOn: 1, customDays: 4, showWeekends: true };

const iso = (days: ReadonlyArray<number>) => days.map(formatDayNumber);

describe("visible days", () => {
  it("builds weeks from the chosen first weekday, optionally without weekends", () => {
    const wednesday = day("2026-09-30");
    expect(iso(weekViewDays(wednesday, 1, true))).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
    expect(iso(weekViewDays(wednesday, 0, true))[0]).toBe("2026-09-27");
    expect(iso(weekViewDays(wednesday, 1, false))).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
  });

  it("counts only shown days in custom views", () => {
    const thursday = day("2026-10-01");
    expect(iso(customViewDays(thursday, 4, false))).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-05",
      "2026-10-06",
    ]);
    expect(iso(customViewDays(day("2026-10-03"), 2, false))).toEqual(["2026-10-05", "2026-10-06"]);
    expect(timeGridDays("custom", thursday, prefs)).toHaveLength(4);
    expect(timeGridDays("day", thursday, prefs)).toEqual([thursday]);
  });

  it("pages custom and day views over hidden weekends", () => {
    const noWeekends = { ...prefs, showWeekends: false };
    const thursday = day("2026-10-01");
    expect(formatDayNumber(stepAnchor("custom", thursday, 1, noWeekends))).toBe("2026-10-07");
    expect(formatDayNumber(stepAnchor("custom", day("2026-10-07"), -1, noWeekends))).toBe(
      "2026-10-01",
    );
    expect(formatDayNumber(stepAnchor("day", day("2026-10-02"), 1, noWeekends))).toBe("2026-10-05");
    expect(formatDayNumber(stepAnchor("month", day("2026-01-31"), 1, prefs))).toBe("2026-02-28");
  });

  it("covers the month with at least five week rows", () => {
    const september = monthViewWeeks(day("2026-09-15"), 1, true);
    expect(september).toHaveLength(5);
    expect(formatDayNumber(september[0]![0]!)).toBe("2026-08-31");
    expect(formatDayNumber(september[4]![6]!)).toBe("2026-10-04");
    // February 2026 starts on a Sunday and fills exactly four Sunday-first weeks.
    expect(monthViewWeeks(day("2026-02-10"), 0, true)).toHaveLength(5);
    // August 2026 starts on a Saturday: six Monday-first rows.
    expect(monthViewWeeks(day("2026-08-10"), 1, true)).toHaveLength(6);
    expect(monthViewWeeks(day("2026-09-15"), 1, false)[0]).toHaveLength(5);
  });
});

describe("bucketInstances", () => {
  const week = weekViewDays(day("2026-09-30"), 1, true);

  it("places timed events by local wall-clock minutes", () => {
    const buckets = bucketInstances(
      [timed("a", "2026-09-30", "09:15", "10:45", BERLIN)],
      week,
      BERLIN,
    );
    const wednesday = buckets.timed[2]!;
    expect(wednesday).toHaveLength(1);
    expect(wednesday[0]).toMatchObject({
      key: "cal/a",
      startMinutes: 555,
      endMinutes: 645,
      continuesBefore: false,
      continuesAfter: false,
    });
    expect(buckets.spans).toHaveLength(0);
    // The same instant in New York is 03:15.
    const newYork = bucketInstances(
      buckets.timed[2]!.map((s) => s.instance),
      week,
      NEW_YORK,
    );
    expect(newYork.timed[2]![0]!.startMinutes).toBe(195);
  });

  it("splits events that cross midnight and ends at 24:00", () => {
    const buckets = bucketInstances(
      [
        timed("late", "2026-09-30", "22:00", "02:00", BERLIN, {}, "2026-10-01"),
        timed("midnight", "2026-10-01", "23:00", "00:00", BERLIN, {}, "2026-10-02"),
      ],
      week,
      BERLIN,
    );
    expect(buckets.timed[2]![0]).toMatchObject({
      startMinutes: 1320,
      endMinutes: 1440,
      continuesAfter: true,
    });
    expect(buckets.timed[3]!.map((s) => [s.key, s.startMinutes, s.endMinutes])).toEqual([
      ["cal/late", 0, 120],
      ["cal/midnight", 1380, 1440],
    ]);
    expect(buckets.timed[4]).toHaveLength(0);
  });

  it("handles the spring-forward day in Berlin (23 hours)", () => {
    const days = [day("2026-03-29")];
    const buckets = bucketInstances(
      [
        // 01:00 to 04:00 local is two real hours; it spans three wall-clock hours on the grid.
        timed("gap", "2026-03-29", "01:00", "04:00", BERLIN),
        // 02:30 does not exist; it resolves forward to 03:30.
        timed("missing", "2026-03-29", "02:30", "05:00", BERLIN),
        timed("allday", "2026-03-29", "00:00", "00:00", BERLIN, {}, "2026-03-30"),
      ],
      days,
      BERLIN,
    );
    expect(buckets.timed[0]!.map((s) => [s.key, s.startMinutes, s.endMinutes])).toEqual([
      ["cal/allday", 0, 1440],
      ["cal/gap", 60, 240],
      ["cal/missing", 210, 300],
    ]);
  });

  it("keeps fall-back events in New York visible (25 hours)", () => {
    const days = [day("2026-11-01")];
    // 01:30 EDT (05:30Z) to 01:10 EST (06:10Z): 40 minutes while the wall clock runs back.
    const overlap = instance("overlap", {
      start: Date.UTC(2026, 10, 1, 5, 30),
      end: Date.UTC(2026, 10, 1, 6, 10),
    });
    // The whole local day is 25 hours, so it becomes a span.
    const wholeDay = timed("whole", "2026-11-01", "00:00", "00:00", NEW_YORK, {}, "2026-11-02");
    const buckets = bucketInstances([overlap, wholeDay], days, NEW_YORK);
    expect(buckets.timed[0]!.map((s) => [s.key, s.startMinutes, s.endMinutes])).toEqual([
      ["cal/overlap", 90, 130],
    ]);
    expect(buckets.spans.map((s) => [s.key, s.kind, s.startIndex, s.endIndex])).toEqual([
      ["cal/whole", "timedSpan", 0, 0],
    ]);
  });

  it("treats all-day dates as floating in every zone", () => {
    const event = allDay("holiday", "2026-10-01", "2026-10-02");
    for (const zone of ["Pacific/Kiritimati", "Etc/GMT+12", BERLIN, "UTC"]) {
      const buckets = bucketInstances([event], week, zone);
      expect(buckets.spans.map((s) => [s.startIndex, s.endIndex])).toEqual([[3, 3]]);
    }
  });

  it("clips spans to visible days, across hidden weekends", () => {
    const weekdays = weekViewDays(day("2026-09-30"), 1, false);
    const buckets = bucketInstances(
      [
        allDay("trip", "2026-10-02", "2026-10-06"), // Fri to Mon
        allDay("weekend", "2026-10-03", "2026-10-05"), // Sat and Sun only
        timed("conference", "2026-09-27", "10:00", "12:00", BERLIN, {}, "2026-09-29"),
      ],
      weekdays,
      BERLIN,
    );
    expect(
      buckets.spans.map((s) => [
        s.key,
        s.startIndex,
        s.endIndex,
        s.continuesBefore,
        s.continuesAfter,
      ]),
    ).toEqual([
      ["cal/conference", 0, 1, true, false],
      ["cal/trip", 4, 4, false, true],
    ]);
    const nextWeek = bucketInstances(
      [allDay("trip", "2026-10-02", "2026-10-06")],
      weekViewDays(day("2026-10-05"), 1, false),
      BERLIN,
    );
    expect(nextWeek.spans.map((s) => [s.startIndex, s.endIndex, s.continuesBefore])).toEqual([
      [0, 0, true],
    ]);
  });

  it("drops declined events when asked", () => {
    const declined = timed("no", "2026-09-30", "09:00", "10:00", BERLIN, { response: "declined" });
    expect(bucketInstances([declined], week, BERLIN).timed[2]).toHaveLength(1);
    expect(bucketInstances([declined], week, BERLIN, false).timed[2]).toHaveLength(0);
  });

  it("slices spans into week rows", () => {
    const monthDays = monthViewWeeks(day("2026-09-15"), 1, true).flat();
    const buckets = bucketInstances(
      [allDay("long", "2026-09-05", "2026-09-09")],
      monthDays,
      BERLIN,
    );
    expect(
      sliceSpans(buckets.spans, 0, 7).map((s) => [s.startIndex, s.endIndex, s.continuesAfter]),
    ).toEqual([[5, 6, true]]);
    expect(
      sliceSpans(buckets.spans, 7, 14).map((s) => [s.startIndex, s.endIndex, s.continuesBefore]),
    ).toEqual([[0, 1, true]]);
  });
});

describe("DayBucketCache", () => {
  it("reuses unchanged days across updates and navigation", () => {
    const cache = new DayBucketCache();
    const week = weekViewDays(day("2026-09-30"), 1, true);
    const monday = timed("mon", "2026-09-28", "09:00", "10:00", BERLIN);
    const tuesday = timed("tue", "2026-09-29", "09:00", "10:00", BERLIN);
    const first = cache.bucket([monday, tuesday], week, BERLIN);
    // Equal data in new objects: everything is reused, down to the result itself.
    const same = cache.bucket([{ ...monday }, { ...tuesday }], week, BERLIN);
    expect(same).toBe(first);

    const moved = { ...tuesday, title: "renamed" };
    const second = cache.bucket([monday, moved], week, BERLIN);
    expect(second).not.toBe(first);
    expect(second.timed[0]).toBe(first.timed[0]);
    expect(second.timed[1]).not.toBe(first.timed[1]);
    expect(second.timed[4]).toBe(first.timed[4]);

    const nextWeek = weekViewDays(day("2026-10-07"), 1, true);
    cache.bucket([monday, moved], nextWeek, BERLIN);
    const back = cache.bucket([monday, moved], week, BERLIN);
    expect(back.timed[0]).toBe(first.timed[0]);
    expect(back.timed[1]).toBe(second.timed[1]);
  });
});

describe("reuseItems", () => {
  it("keeps unchanged items of a changed list", () => {
    const a = allDay("a", "2026-10-01", "2026-10-02");
    const b = allDay("b", "2026-10-02", "2026-10-03");
    const days = weekViewDays(day("2026-09-30"), 1, true);
    const first = bucketInstances([a, b], days, BERLIN).spans;
    const second = bucketInstances([{ ...a }, { ...b, title: "changed" }], days, BERLIN).spans;
    const reused = reuseItems(
      first,
      second,
      (x, y) => x.key === y.key && sameInstance(x.instance, y.instance),
    );
    expect(reused).not.toBe(first);
    expect(reused[0]).toBe(first[0]);
    expect(reused[1]).toBe(second[1]);
    expect(reuseItems([], [], () => true)).toHaveLength(0);
  });
});
