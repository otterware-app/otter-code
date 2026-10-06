import { CalendarId, type CalendarEventDetails } from "@t3tools/contracts";
import { dayNumber } from "@t3tools/shared/calendar/time";
import { describe, expect, it } from "vite-plus/test";

import {
  type EditorForm,
  createInput,
  editorChanges,
  formForEvent,
  formRange,
  parseTimeText,
  recurrenceForChoice,
  repeatChoiceLabel,
  repeatChoiceOf,
  withEnd,
  withStart,
} from "./eventEditor.logic";

const BERLIN = "Europe/Berlin";
const OCT_1 = dayNumber(2026, 10, 1); // a Thursday

function form(overrides: Partial<EditorForm> = {}): EditorForm {
  return {
    title: "Standup",
    allDay: false,
    startDay: OCT_1,
    startMinutes: 9 * 60,
    endDay: OCT_1,
    endMinutes: 9 * 60 + 30,
    timeZone: BERLIN,
    repeat: "none",
    calendarId: "work",
    location: "",
    description: "",
    guests: [],
    addConference: false,
    free: false,
    visibility: "default",
    ...overrides,
  };
}

describe("parseTimeText", () => {
  it.each([
    ["9", 540],
    ["930", 570],
    ["9:30", 570],
    ["9.30", 570],
    ["9am", 540],
    ["9:30 pm", 1290],
    ["12am", 0],
    ["12 PM", 720],
    ["21:15", 1275],
    ["noon", 720],
  ])("reads %s", (text, minutes) => {
    expect(parseTimeText(text)).toBe(minutes);
  });

  it.each(["25:00", "9:75", "13pm", "soon", ""])("rejects %s", (text) => {
    expect(parseTimeText(text)).toBeNull();
  });
});

describe("repeat choices", () => {
  const anchor = { start: Date.UTC(2026, 9, 1, 7), allDay: false, timeZone: BERLIN };

  it("reads the picker's choice back from the rule it built", () => {
    for (const choice of [
      "daily",
      "weekdays",
      "weekly",
      "monthlyDay",
      "monthlyWeekday",
      "yearly",
    ] as const) {
      expect(repeatChoiceOf(recurrenceForChoice(choice, anchor, []), anchor)).toBe(choice);
    }
    expect(repeatChoiceOf([], anchor)).toBe("none");
    expect(repeatChoiceOf(["RRULE:FREQ=WEEKLY;INTERVAL=2"], anchor)).toBe("custom");
    expect(repeatChoiceOf(["RRULE:FREQ=DAILY;COUNT=5"], anchor)).toBe("custom");
  });

  it("keeps exception dates and custom rules", () => {
    const existing = ["RRULE:FREQ=WEEKLY;INTERVAL=2", "EXDATE:20261015T070000Z"];
    expect(recurrenceForChoice("custom", anchor, existing)).toBe(existing);
    expect(recurrenceForChoice("daily", anchor, existing)).toEqual([
      "RRULE:FREQ=DAILY",
      "EXDATE:20261015T070000Z",
    ]);
    expect(recurrenceForChoice("none", anchor, existing)).toEqual([]);
  });

  it("labels choices in words", () => {
    expect(repeatChoiceLabel("weekly", anchor)).toBe("Weekly on Thursday");
    expect(repeatChoiceLabel("monthlyWeekday", anchor)).toBe("Monthly on the first Thursday");
    expect(repeatChoiceLabel("none", anchor)).toBe("Does not repeat");
  });
});

describe("editing times", () => {
  it("keeps the duration when the start moves and rolls a too-early end to the next day", () => {
    const moved = withStart(form(), OCT_1 + 1, 14 * 60);
    expect([moved.startDay, moved.startMinutes, moved.endDay, moved.endMinutes]).toEqual([
      OCT_1 + 1,
      14 * 60,
      OCT_1 + 1,
      14 * 60 + 30,
    ]);
    const overnight = withEnd(form({ startMinutes: 23 * 60 }), OCT_1, 60);
    expect([overnight.endDay, overnight.endMinutes]).toEqual([OCT_1 + 1, 60]);
  });

  it("uses UTC-midnight dates with an exclusive end for all-day events", () => {
    expect(formRange(form({ allDay: true, endDay: OCT_1 + 1 }))).toEqual({
      start: Date.UTC(2026, 9, 1),
      end: Date.UTC(2026, 9, 3),
      allDay: true,
    });
  });
});

describe("editorChanges", () => {
  const details: CalendarEventDetails = {
    calendarId: CalendarId.make("work"),
    eventId: "e1",
    title: "Standup",
    start: Date.UTC(2026, 9, 1, 7),
    end: Date.UTC(2026, 9, 1, 7, 30),
    description: "Daily sync",
    timeZone: BERLIN,
    attendees: [
      { email: "me@example.com", responseStatus: "accepted", self: true, organizer: true },
      { email: "ana@example.com", responseStatus: "needsAction" },
    ],
    canRespond: false,
  };

  it("sends only what changed", () => {
    const initial = formForEvent(details, details, "America/New_York");
    expect(initial).toMatchObject({
      startMinutes: 9 * 60,
      timeZone: BERLIN,
      guests: ["ana@example.com"],
    });
    expect(editorChanges(initial, initial, [])).toEqual({});
    expect(editorChanges(initial, { ...initial, title: "Sync" }, [])).toEqual({ title: "Sync" });
    expect(editorChanges(initial, withStart(initial, OCT_1, 10 * 60), [])).toEqual({
      time: {
        allDay: false,
        start: "2026-10-01T10:00:00+02:00",
        end: "2026-10-01T10:30:00+02:00",
        timeZone: BERLIN,
      },
    });
    expect(editorChanges(initial, { ...initial, guests: [], calendarId: "home" }, [])).toEqual({
      attendees: [],
      targetCalendarId: "home",
    });
  });

  it("re-anchors a simple rule when the time moves", () => {
    const initial = { ...formForEvent(details, details, BERLIN), repeat: "weekly" as const };
    const moved = withStart(initial, OCT_1 + 1, 9 * 60);
    expect(editorChanges(initial, moved, ["RRULE:FREQ=WEEKLY;BYDAY=TH"]).recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=FR",
    ]);
  });
});

describe("createInput", () => {
  it("builds a create input with only filled fields", () => {
    expect(createInput(form({ repeat: "daily", guests: ["a@b.co"] }))).toEqual({
      calendarId: "work",
      time: {
        allDay: false,
        start: "2026-10-01T09:00:00+02:00",
        end: "2026-10-01T09:30:00+02:00",
        timeZone: BERLIN,
      },
      title: "Standup",
      attendees: ["a@b.co"],
      recurrence: ["RRULE:FREQ=DAILY"],
    });
  });
});
