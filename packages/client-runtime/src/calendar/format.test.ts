import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  formatDayHeader,
  formatDuration,
  formatEventLabel,
  formatEventTime,
  formatHourLabel,
  formatMinutesRange,
  formatMonthTitle,
  formatRangeTitle,
  formatRelativeDay,
  formatTime,
  formatTimeRange,
  formatZoneName,
  setCalendarLocale,
  usesTwelveHour,
} from "./format.ts";
import { allDay, day, timed } from "./testFixtures.ts";

// Intl puts narrow and thin no-break spaces around AM/PM and range dashes.
const plain = (value: string) => value.replace(/[   ]/g, " ");
const BERLIN = "Europe/Berlin";

beforeAll(() => setCalendarLocale("en-US"));
afterAll(() => setCalendarLocale(undefined));

describe("time labels", () => {
  it("follows the hour format preference", () => {
    expect(usesTwelveHour("locale")).toBe(true);
    expect(usesTwelveHour("24")).toBe(false);
    expect(plain(formatHourLabel(9, "locale"))).toBe("9 AM");
    expect(plain(formatHourLabel(13, "12"))).toBe("1 PM");
    expect(formatHourLabel(9, "24")).toBe("09:00");
    expect(formatHourLabel(0, "24")).toBe("00:00");
  });

  it("formats times in the view's zone, dropping :00 on 12-hour clocks", () => {
    const at = Date.UTC(2026, 8, 30, 7, 30); // 09:30 in Berlin
    expect(plain(formatTime(at, BERLIN, "12"))).toBe("9:30 AM");
    expect(formatTime(at, BERLIN, "24")).toBe("09:30");
    expect(plain(formatTime(Date.UTC(2026, 8, 30, 7), BERLIN, "12"))).toBe("9 AM");
    expect(formatTime(Date.UTC(2026, 8, 30, 7), BERLIN, "24")).toBe("09:00");
  });

  it("shares the day period across a range", () => {
    const event = timed("a", "2026-09-30", "09:30", "10:30", BERLIN);
    expect(plain(formatTimeRange(event.start, event.end, BERLIN, "12"))).toBe("9:30 – 10:30 AM");
    const lunch = timed("b", "2026-09-30", "11:00", "13:00", BERLIN);
    expect(plain(formatTimeRange(lunch.start, lunch.end, BERLIN, "12"))).toBe("11 AM – 1 PM");
    expect(formatTimeRange(event.start, event.end, BERLIN, "24")).toBe("09:30 – 10:30");
    expect(plain(formatMinutesRange(540, 555, "12"))).toBe("9 – 9:15 AM");
  });

  it("formats durations", () => {
    expect(formatDuration(30)).toBe("30 min");
    expect(formatDuration(60)).toBe("1 hr");
    expect(formatDuration(105)).toBe("1 hr 45 min");
    expect(formatDuration(1440)).toBe("1 day");
    expect(formatDuration(4320)).toBe("3 days");
  });

  it("names zones", () => {
    expect(formatZoneName(BERLIN, Date.UTC(2026, 8, 30))).toBe("GMT+2");
    expect(formatZoneName("UTC", Date.UTC(2026, 8, 30))).toBe("UTC");
  });
});

describe("day labels", () => {
  it("formats headers and titles from civil days", () => {
    expect(formatDayHeader(day("2026-09-28"))).toEqual({ weekday: "Mon", date: "28" });
    expect(formatMonthTitle(day("2026-09-15"))).toBe("September 2026");
    expect(plain(formatRangeTitle(day("2026-09-28"), day("2026-10-04")))).toBe(
      "Sep 28 – Oct 4, 2026",
    );
    expect(plain(formatRangeTitle(day("2026-10-05"), day("2026-10-11")))).toBe("Oct 5 – 11, 2026");
    expect(plain(formatRangeTitle(day("2026-12-28"), day("2027-01-03")))).toBe(
      "Dec 28, 2026 – Jan 3, 2027",
    );
    expect(formatRangeTitle(day("2026-09-30"), day("2026-09-30"))).toBe("Sep 30, 2026");
    const today = day("2026-09-30");
    expect(formatRelativeDay(today, today)).toBe("Today");
    expect(formatRelativeDay(today + 1, today)).toBe("Tomorrow");
    expect(formatRelativeDay(today + 2, today)).toBe("Fri, Oct 2");
  });
});

describe("event labels", () => {
  it("describes timed, all-day and multi-day events", () => {
    const standup = timed("Standup", "2026-09-30", "09:00", "09:30", BERLIN, {
      location: "Room 3",
      response: "tentative",
    });
    expect(plain(formatEventTime(standup, BERLIN, "12"))).toBe("9 – 9:30 AM");
    expect(plain(formatEventLabel(standup, BERLIN, "12"))).toBe(
      "Standup, Wed, Sep 30, 9 – 9:30 AM, Room 3, Maybe",
    );
    expect(formatEventTime(allDay("h", "2026-10-01", "2026-10-02"), BERLIN, "12")).toBe("All day");
    expect(plain(formatEventTime(allDay("t", "2026-10-01", "2026-10-04"), BERLIN, "12"))).toBe(
      "Oct 1 – 3, 2026",
    );
    const overnight = timed("n", "2026-09-30", "22:00", "02:00", BERLIN, {}, "2026-10-01");
    expect(formatEventTime(overnight, BERLIN, "24")).toBe("Wed, Sep 30, 22:00 – Thu, Oct 1, 02:00");
  });
});
