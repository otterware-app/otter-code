import type { CalendarEventInstance } from "@t3tools/contracts";
import { fromZoned, parseDayNumber, toZoned } from "@t3tools/shared/calendar/time";
import { describe, expect, it } from "vite-plus/test";

import {
  type GridHit,
  type TimeGridGeometry,
  createAllDay,
  createTimed,
  hitMonth,
  hitTimeGrid,
  moveIntoAllDay,
  moveIntoGrid,
  moveTimed,
  resizeAllDayEnd,
  resizeEdge,
  resizeTimed,
  shiftDays,
  timedGhostSegments,
} from "./geometry";

const BERLIN = "Europe/Berlin";
const MINUTE = 60_000;

function day(value: string): number {
  return parseDayNumber(value)!;
}

function at(date: string, time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return fromZoned(day(date), hours! * 60 + minutes!, BERLIN);
}

function wall(ms: number): string {
  const { day: civil, minutes } = toZoned(ms, BERLIN);
  const date = new Date(civil * 86_400_000).toISOString().slice(0, 10);
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(Math.round(minutes % 60)).padStart(2, "0");
  return `${date} ${hh}:${mm}`;
}

function event(start: number, end: number, extra: Partial<CalendarEventInstance> = {}) {
  return {
    calendarId: "cal" as CalendarEventInstance["calendarId"],
    eventId: "e",
    title: "Event",
    start,
    end,
    ...extra,
  } satisfies CalendarEventInstance;
}

// Mon 28 Sep to Sun 4 Oct 2026.
const week = Array.from({ length: 7 }, (_, index) => day("2026-09-28") + index);
const hit = (dayIndex: number, minutes: number): GridHit => ({ zone: "timed", dayIndex, minutes });

describe("hitTimeGrid", () => {
  // An 80 px sticky header over a grid scrolled 400 px: 00:00 sits at 80 - 400 = -320.
  const geometry: TimeGridGeometry = {
    columnsLeft: 100,
    columnWidth: 50,
    dayCount: 7,
    gridTop: -320,
    scrollTop0: 400,
    pxPerMinute: 0.8,
    headerBottom: 80,
    viewBottom: 800,
  };

  it("maps viewport points to day and minutes, following scroll", () => {
    expect(hitTimeGrid(geometry, 175, 560, 400)).toEqual(hit(1, 1100));
    // Scrolled 48 px (an hour at 0.8 px/min) further down: the same point is an hour later.
    expect(hitTimeGrid(geometry, 175, 560, 448).minutes).toBe(1160);
    // Past the edges: clamped to the first and last day.
    expect(hitTimeGrid(geometry, 0, 500, 400).dayIndex).toBe(0);
    expect(hitTimeGrid(geometry, 9999, 500, 400).dayIndex).toBe(6);
  });

  it("reports the all-day zone above the grid unless a gesture is timed-only", () => {
    expect(hitTimeGrid(geometry, 175, 60, 400).zone).toBe("allDay");
    const forced = hitTimeGrid(geometry, 175, 60, 400, true);
    expect(forced.zone).toBe("timed");
    // Clamped to the top of the visible grid.
    expect(forced.minutes).toBe(500);
  });
});

describe("gesture results", () => {
  it("draws new events from the anchor, forwards, backwards and across days", () => {
    const forward = createTimed(week, BERLIN, hit(2, 545), hit(2, 628), 15);
    expect([wall(forward.start), wall(forward.end)]).toEqual([
      "2026-09-30 09:00",
      "2026-09-30 10:30",
    ]);
    const backward = createTimed(week, BERLIN, hit(2, 545), hit(2, 470), 15);
    expect([wall(backward.start), wall(backward.end)]).toEqual([
      "2026-09-30 07:45",
      "2026-09-30 09:15",
    ]);
    const tiny = createTimed(week, BERLIN, hit(2, 545), hit(2, 546), 15);
    expect(tiny.end - tiny.start).toBe(15 * MINUTE);
    const acrossDays = createTimed(week, BERLIN, hit(1, 1320), hit(2, 120), 15);
    expect([wall(acrossDays.start), wall(acrossDays.end)]).toEqual([
      "2026-09-29 22:00",
      "2026-09-30 02:00",
    ]);
    expect(createAllDay(week[3]!, week[1]!)).toEqual({
      start: week[1]! * 86_400_000,
      end: (week[3]! + 1) * 86_400_000,
      allDay: true,
    });
  });

  it("moves timed events with the grab offset, snapping the start and keeping duration", () => {
    const standup = event(at("2026-09-30", "10:07"), at("2026-09-30", "10:37"));
    // Grabbed 10 minutes into the block, dropped a day later and ~an hour down.
    const moved = moveTimed(week, BERLIN, standup, hit(2, 617), hit(3, 679), 15);
    expect([wall(moved.start), wall(moved.end)]).toEqual(["2026-10-01 11:15", "2026-10-01 11:45"]);
    // Dragged above midnight: stays in the pointer's day.
    const top = moveTimed(week, BERLIN, standup, hit(2, 617), hit(2, 0), 15);
    expect(wall(top.start)).toBe("2026-09-30 00:00");
  });

  it("keeps real duration when moving onto a DST change", () => {
    const days = [day("2026-10-24"), day("2026-10-25")];
    const late = event(at("2026-10-24", "01:00"), at("2026-10-24", "04:00"));
    const moved = moveTimed(days, BERLIN, late, hit(0, 60), hit(1, 60), 15);
    expect(wall(moved.start)).toBe("2026-10-25 01:00");
    // Three real hours across the fall-back hour end at 03:00 on the wall clock.
    expect(moved.end - moved.start).toBe(3 * 60 * MINUTE);
    expect(wall(moved.end)).toBe("2026-10-25 03:00");
  });

  it("converts between timed and all-day", () => {
    const allDay = event(week[1]! * 86_400_000, (week[1]! + 1) * 86_400_000, { allDay: true });
    const intoGrid = moveIntoGrid(week, BERLIN, allDay, hit(4, 842), 15, 30);
    expect([wall(intoGrid.start), wall(intoGrid.end), intoGrid.allDay]).toEqual([
      "2026-10-02 14:00",
      "2026-10-02 14:30",
      false,
    ]);
    expect(moveIntoAllDay(week[5]!)).toEqual({
      start: week[5]! * 86_400_000,
      end: (week[5]! + 1) * 86_400_000,
      allDay: true,
    });
  });

  it("shifts by days keeping the time of day, across DST", () => {
    const meeting = event(at("2026-10-23", "09:00"), at("2026-10-23", "10:00"));
    const nextWeek = shiftDays(meeting, BERLIN, 7);
    expect([wall(nextWeek.start), wall(nextWeek.end)]).toEqual([
      "2026-10-30 09:00",
      "2026-10-30 10:00",
    ]);
    const trip = event(day("2026-10-01") * 86_400_000, day("2026-10-04") * 86_400_000, {
      allDay: true,
    });
    expect(shiftDays(trip, BERLIN, -2)).toEqual({
      start: day("2026-09-29") * 86_400_000,
      end: day("2026-10-02") * 86_400_000,
      allDay: true,
    });
  });

  it("resizes without inverting the event", () => {
    const standup = event(at("2026-09-30", "10:00"), at("2026-09-30", "10:30"));
    const longer = resizeTimed(week, BERLIN, standup, "end", hit(2, 692), 15);
    expect(wall(longer.end)).toBe("2026-09-30 11:30");
    const inverted = resizeTimed(week, BERLIN, standup, "end", hit(2, 300), 15);
    expect(inverted.end - inverted.start).toBe(15 * MINUTE);
    const earlier = resizeTimed(week, BERLIN, standup, "start", hit(2, 540), 15);
    expect(wall(earlier.start)).toBe("2026-09-30 09:00");
    const trip = event(day("2026-10-01") * 86_400_000, day("2026-10-02") * 86_400_000, {
      allDay: true,
    });
    expect(resizeAllDayEnd(trip, day("2026-10-03")).end).toBe(day("2026-10-04") * 86_400_000);
    expect(resizeAllDayEnd(trip, day("2026-09-20")).end).toBe(day("2026-10-02") * 86_400_000);
  });
});

describe("resize edges", () => {
  const block = { top: 100, bottom: 160, left: 10, right: 110 };
  const both = { vertical: true, start: true, end: true, coarse: false };

  it("hits the top and bottom bands of timed blocks", () => {
    expect(resizeEdge(block, 50, 103, both)).toBe("start");
    expect(resizeEdge(block, 50, 157, both)).toBe("end");
    expect(resizeEdge(block, 50, 130, both)).toBeNull();
    // A continuing block has no start edge; touch bands are wider.
    expect(resizeEdge(block, 50, 103, { ...both, start: false })).toBeNull();
    expect(resizeEdge(block, 50, 149, { ...both, coarse: true })).toBe("end");
    // A short block keeps its middle third for moving.
    const short = { top: 100, bottom: 112, left: 10, right: 110 };
    expect(resizeEdge(short, 50, 106, both)).toBeNull();
    expect(resizeEdge(short, 50, 111, both)).toBe("end");
  });

  it("hits the end of bars", () => {
    const bar = { top: 0, bottom: 20, left: 10, right: 210 };
    const options = { vertical: false, start: false, end: true, coarse: false };
    expect(resizeEdge(bar, 207, 10, options)).toBe("end");
    expect(resizeEdge(bar, 150, 10, options)).toBeNull();
    expect(resizeEdge(bar, 207, 10, { ...options, end: false })).toBeNull();
  });
});

describe("ghost placement", () => {
  it("splits a timed proposal into per-column segments, skipping hidden days", () => {
    const overnight = {
      start: at("2026-10-02", "22:00"),
      end: at("2026-10-05", "02:00"),
      allDay: false,
    };
    const weekdays = week.filter((_, index) => index < 5).concat([day("2026-10-05")]);
    expect(timedGhostSegments(weekdays, BERLIN, overnight)).toEqual([
      { dayIndex: 4, startMinutes: 1320, endMinutes: 1440 },
      { dayIndex: 5, startMinutes: 0, endMinutes: 120 },
    ]);
    const toMidnight = {
      start: at("2026-09-30", "23:00"),
      end: at("2026-10-01", "00:00"),
      allDay: false,
    };
    expect(timedGhostSegments(week, BERLIN, toMidnight)).toEqual([
      { dayIndex: 2, startMinutes: 1380, endMinutes: 1440 },
    ]);
  });

  it("finds month cells", () => {
    const geometry = { left: 0, top: 100, cellWidth: 100, cellHeight: 80, columns: 7, rows: 6 };
    expect(hitMonth(geometry, 250, 100 + 80 * 2 + 5)).toBe(16);
    expect(hitMonth(geometry, -10, 10_000)).toBe(35);
  });
});
