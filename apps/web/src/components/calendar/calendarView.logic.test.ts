import { CalendarAccountId, CalendarId, type Calendar } from "@t3tools/contracts";
import { dayNumber, fromZoned } from "@t3tools/shared/calendar/time";
import { describe, expect, it } from "vite-plus/test";

import {
  calendarRange,
  defaultCalendarId,
  defaultDraft,
  neighbourWeeks,
  rangeWeeks,
  shownInstances,
  validateCalendarSearch,
} from "./calendarView.logic";

const PREFS = { weekStartsOn: 1, customDays: 4, showWeekends: true } as const;
const SEP_30 = dayNumber(2026, 9, 30); // a Wednesday

describe("validateCalendarSearch", () => {
  it("keeps valid params and drops the rest", () => {
    expect(validateCalendarSearch({ view: "month", date: "2026-09-30" })).toEqual({
      view: "month",
      date: "2026-09-30",
    });
    expect(validateCalendarSearch({ view: "year", date: "2026-02-30" })).toEqual({});
  });
});

describe("calendarRange", () => {
  it("titles a week that spans two months with the range", () => {
    const week = calendarRange("week", SEP_30, PREFS);
    expect(week.days).toHaveLength(7);
    expect(week.firstDay).toBe(dayNumber(2026, 9, 28));
    // Intl puts thin spaces around the dash.
    expect(week.title.replace(/\s/g, " ")).toBe("Sep 28 – Oct 4, 2026");
    expect(calendarRange("week", dayNumber(2026, 9, 16), PREFS).title).toBe("September 2026");
  });

  it("lists month rows and a day title", () => {
    const month = calendarRange("month", SEP_30, PREFS);
    expect(month.weeks.length).toBeGreaterThanOrEqual(5);
    expect(month.title).toBe("September 2026");
    expect(calendarRange("day", SEP_30, PREFS).title).toBe("Wednesday, September 30, 2026");
  });
});

describe("week chunks", () => {
  it("covers the view and prefetches the neighbouring pages only", () => {
    const week = calendarRange("week", SEP_30, PREFS);
    const shown = rangeWeeks(week, "Europe/Berlin");
    expect(shown[0]).toBe("2026-09-21");
    const neighbours = neighbourWeeks("week", SEP_30, PREFS, "Europe/Berlin", shown);
    expect(neighbours.some((weekKey) => shown.includes(weekKey))).toBe(false);
    expect(neighbours).toContain("2026-10-05");
  });
});

describe("shownInstances", () => {
  const base = { title: "x", start: 0, end: 1 };
  const instances = [
    { ...base, calendarId: CalendarId.make("work"), eventId: "a" },
    { ...base, calendarId: CalendarId.make("home"), eventId: "b" },
    { ...base, calendarId: CalendarId.make("work"), eventId: "c", response: "declined" as const },
  ];

  it("drops hidden calendars and, when asked, declined invitations", () => {
    expect(shownInstances(instances, new Set(), true)).toBe(instances);
    expect(shownInstances(instances, new Set(["home"]), false).map((i) => i.eventId)).toEqual([
      "a",
    ]);
  });
});

describe("defaults for new events", () => {
  const calendar = (id: string, extra: Partial<Calendar> = {}): Calendar => ({
    calendarId: CalendarId.make(id),
    accountId: CalendarAccountId.make("acc"),
    name: id,
    color: "#3366ff",
    accessRole: "owner",
    primary: false,
    visible: true,
    ...extra,
  });

  it("prefers the preference, then a writable primary calendar", () => {
    const calendars = [
      calendar("holidays", { accessRole: "reader", primary: true }),
      calendar("work", { primary: true }),
      calendar("home"),
    ];
    expect(defaultCalendarId(calendars, "home")).toBe("home");
    expect(defaultCalendarId(calendars, "holidays")).toBe("work");
    expect(defaultCalendarId([], null)).toBeNull();
  });

  it("starts at the next half hour today and at working hours on other days", () => {
    const zone = "Europe/Berlin";
    const now = fromZoned(SEP_30, 9 * 60 + 10, zone);
    const today = defaultDraft({
      day: SEP_30,
      today: SEP_30,
      now,
      timeZone: zone,
      minutes: 30,
      workingStart: 8 * 60,
      calendarId: "work",
    });
    expect(today.start).toBe(fromZoned(SEP_30, 9 * 60 + 30, zone));
    expect(today.end - today.start).toBe(30 * 60_000);
    const tomorrow = defaultDraft({
      day: SEP_30 + 1,
      today: SEP_30,
      now,
      timeZone: zone,
      minutes: 60,
      workingStart: 8 * 60,
      calendarId: null,
    });
    expect(tomorrow.start).toBe(fromZoned(SEP_30 + 1, 8 * 60, zone));
  });
});
