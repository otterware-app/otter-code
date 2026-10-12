import { describe, expect, it } from "vite-plus/test";

import {
  addMonths,
  civilDate,
  dayNumber,
  formatDayNumber,
  formatZonedIso,
  fromZoned,
  parseDayNumber,
  parseInstant,
  startOfWeek,
  startOfZonedDay,
  endOfZonedDay,
  toZoned,
  weekday,
  zoneOffset,
} from "./time.ts";

const HOUR = 3_600_000;

describe("civil dates", () => {
  it("round-trips day numbers and knows weekdays", () => {
    const day = dayNumber(2026, 9, 30);
    expect(civilDate(day)).toEqual({ year: 2026, month: 9, day: 30 });
    expect(formatDayNumber(day)).toBe("2026-09-30");
    expect(parseDayNumber("2026-09-30")).toBe(day);
    expect(weekday(day)).toBe(3); // Wednesday
    expect(weekday(dayNumber(1969, 12, 31))).toBe(3);
    expect(parseDayNumber("2026-02-30")).toBeNull();
  });

  it("starts weeks on the chosen weekday", () => {
    const wednesday = dayNumber(2026, 9, 30);
    expect(formatDayNumber(startOfWeek(wednesday, 1))).toBe("2026-09-28");
    expect(formatDayNumber(startOfWeek(wednesday, 0))).toBe("2026-09-27");
    expect(formatDayNumber(startOfWeek(wednesday, 6))).toBe("2026-09-26");
  });

  it("clamps the day when adding months", () => {
    expect(formatDayNumber(addMonths(dayNumber(2026, 1, 31), 1))).toBe("2026-02-28");
    expect(formatDayNumber(addMonths(dayNumber(2028, 1, 31), 1))).toBe("2028-02-29");
    expect(formatDayNumber(addMonths(dayNumber(2026, 12, 15), 2))).toBe("2027-02-15");
    expect(formatDayNumber(addMonths(dayNumber(2026, 3, 15), -3))).toBe("2025-12-15");
  });
});

describe("zones", () => {
  it("computes offsets on both sides of a transition", () => {
    // Europe/Berlin springs forward at 2026-03-29 01:00 UTC.
    const transition = Date.UTC(2026, 2, 29, 1);
    expect(zoneOffset("Europe/Berlin", transition - 1)).toBe(HOUR);
    expect(zoneOffset("Europe/Berlin", transition)).toBe(2 * HOUR);
    expect(zoneOffset("America/New_York", Date.UTC(2026, 6, 1))).toBe(-4 * HOUR);
    expect(zoneOffset("Asia/Kathmandu", Date.UTC(2026, 6, 1))).toBe(5.75 * HOUR);
    expect(zoneOffset("UTC", Date.UTC(2026, 6, 1))).toBe(0);
  });

  it("converts wall times, moving gap times forward and picking the earlier overlap", () => {
    const march29 = dayNumber(2026, 3, 29);
    // 02:30 does not exist in Berlin on 2026-03-29: it becomes 03:30 CEST.
    expect(fromZoned(march29, 150, "Europe/Berlin")).toBe(Date.UTC(2026, 2, 29, 1, 30));
    // 09:00 is CEST after the change.
    expect(fromZoned(march29, 540, "Europe/Berlin")).toBe(Date.UTC(2026, 2, 29, 7));
    const october25 = dayNumber(2026, 10, 25);
    // 02:30 happens twice in Berlin on 2026-10-25: the earlier one is 00:30 UTC.
    expect(fromZoned(october25, 150, "Europe/Berlin")).toBe(Date.UTC(2026, 9, 25, 0, 30));
    expect(fromZoned(october25, 180, "Europe/Berlin")).toBe(Date.UTC(2026, 9, 25, 2));
    // New York: 2026-03-08 02:30 is in the gap; 2026-11-01 01:30 is ambiguous.
    expect(fromZoned(dayNumber(2026, 3, 8), 150, "America/New_York")).toBe(
      Date.UTC(2026, 2, 8, 7, 30),
    );
    expect(fromZoned(dayNumber(2026, 11, 1), 90, "America/New_York")).toBe(
      Date.UTC(2026, 10, 1, 5, 30),
    );
  });

  it("handles half-hour transitions (Lord Howe) and odd offsets (Chatham)", () => {
    // Lord Howe goes from +10:30 to +11 at 2026-10-04 02:00 local.
    const day = dayNumber(2026, 10, 4);
    expect(fromZoned(day, 135, "Australia/Lord_Howe")).toBe(
      fromZoned(day, 165, "Australia/Lord_Howe"),
    );
    expect(toZoned(fromZoned(day, 9 * 60, "Australia/Lord_Howe"), "Australia/Lord_Howe")).toEqual({
      day,
      minutes: 540,
    });
    const chatham = fromZoned(dayNumber(2026, 1, 15), 600, "Pacific/Chatham");
    expect(toZoned(chatham, "Pacific/Chatham").minutes).toBe(600);
  });

  it("knows how long local days are", () => {
    const spring = dayNumber(2026, 3, 29);
    const fall = dayNumber(2026, 10, 25);
    const summer = dayNumber(2026, 7, 1);
    const length = (day: number) =>
      (endOfZonedDay(day, "Europe/Berlin") - startOfZonedDay(day, "Europe/Berlin")) / HOUR;
    expect(length(spring)).toBe(23);
    expect(length(fall)).toBe(25);
    expect(length(summer)).toBe(24);
  });

  it("round-trips every quarter hour of a transition day", () => {
    for (const zone of ["Europe/Berlin", "America/Sao_Paulo", "Australia/Sydney", "Asia/Tokyo"]) {
      for (const day of [dayNumber(2026, 3, 29), dayNumber(2026, 10, 4), dayNumber(2026, 11, 1)]) {
        for (let minutes = 0; minutes < 1440; minutes += 15) {
          const ms = fromZoned(day, minutes, zone);
          const back = toZoned(ms, zone);
          // Gap times move forward, so the wall time is never earlier than requested.
          expect(back.day * 1440 + back.minutes).toBeGreaterThanOrEqual(day * 1440 + minutes);
          expect(back.day * 1440 + back.minutes - (day * 1440 + minutes)).toBeLessThanOrEqual(60);
        }
      }
    }
  });
});

describe("instant strings", () => {
  it("parses offsets, Z and zone-local strings", () => {
    expect(parseInstant("2026-10-01T09:00:00Z")).toBe(Date.UTC(2026, 9, 1, 9));
    expect(parseInstant("2026-10-01T09:00:00+02:00")).toBe(Date.UTC(2026, 9, 1, 7));
    expect(parseInstant("2026-10-01T09:00:00.500-05:30")).toBe(
      Date.UTC(2026, 9, 1, 14, 30, 0, 500),
    );
    expect(parseInstant("2026-10-01T09:00", "Europe/Berlin")).toBe(Date.UTC(2026, 9, 1, 7));
    expect(parseInstant("tomorrow")).toBeNull();
  });

  it("formats with the zone's offset", () => {
    const ms = Date.UTC(2026, 9, 1, 7, 15, 30);
    expect(formatZonedIso(ms, "Europe/Berlin")).toBe("2026-10-01T09:15:30+02:00");
    expect(formatZonedIso(ms, "America/St_Johns")).toBe("2026-10-01T04:45:30-02:30");
    expect(formatZonedIso(ms, "UTC")).toBe("2026-10-01T07:15:30+00:00");
  });
});
