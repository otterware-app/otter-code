import {
  CalendarAccountId,
  CalendarId,
  type CalendarDirectory,
  type CalendarEventInstance,
  DEFAULT_CALENDAR_PREFERENCES,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  EMPTY_CALENDAR_INSTANCES,
  applyCalendarWeekEvent,
  mergeCalendarChunks,
  shareCalendarDirectory,
} from "./calendar.ts";

const WORK = CalendarId.make("work");
const HOME = CalendarId.make("home");

function instance(
  eventId: string,
  start: number,
  extra: Partial<CalendarEventInstance> = {},
): CalendarEventInstance {
  return { calendarId: WORK, eventId, title: eventId, start, end: start + 3_600_000, ...extra };
}

describe("applyCalendarWeekEvent", () => {
  it("keeps the map and its instances when a snapshot or upsert changes nothing", () => {
    const loaded = applyCalendarWeekEvent(EMPTY_CALENDAR_INSTANCES, {
      _tag: "snapshot",
      instances: [instance("a", 0), instance("b", 10)],
    });
    expect([...loaded.keys()]).toEqual(["work/a", "work/b"]);

    // A reconnect sends the same snapshot again, as new objects.
    const again = applyCalendarWeekEvent(loaded, {
      _tag: "snapshot",
      instances: [instance("a", 0), instance("b", 10)],
    });
    expect(again).toBe(loaded);
    expect(
      applyCalendarWeekEvent(loaded, { _tag: "upserted", instances: [instance("a", 0)] }),
    ).toBe(loaded);
    expect(applyCalendarWeekEvent(loaded, { _tag: "removed", keys: ["work/zzz"] })).toBe(loaded);
  });

  it("replaces only what changed and keeps other instances' identity", () => {
    const loaded = applyCalendarWeekEvent(EMPTY_CALENDAR_INSTANCES, {
      _tag: "snapshot",
      instances: [instance("a", 0), instance("b", 10)],
    });
    const moved = applyCalendarWeekEvent(loaded, {
      _tag: "upserted",
      instances: [instance("a", 0, { title: "Renamed" })],
    });
    expect(moved).not.toBe(loaded);
    expect(moved.get("work/a")?.title).toBe("Renamed");
    expect(moved.get("work/b")).toBe(loaded.get("work/b"));

    const removed = applyCalendarWeekEvent(moved, { _tag: "removed", keys: ["work/a"] });
    expect([...removed.keys()]).toEqual(["work/b"]);
  });

  it("replaces one calendar's instances and leaves the others alone", () => {
    const loaded = applyCalendarWeekEvent(EMPTY_CALENDAR_INSTANCES, {
      _tag: "snapshot",
      instances: [instance("a", 0), instance("h", 0, { calendarId: HOME })],
    });
    const hidden = applyCalendarWeekEvent(loaded, {
      _tag: "calendarReplaced",
      calendarId: WORK,
      instances: [],
    });
    expect([...hidden.keys()]).toEqual(["home/h"]);
    expect(hidden.get("home/h")).toBe(loaded.get("home/h"));

    const same = applyCalendarWeekEvent(loaded, {
      _tag: "calendarReplaced",
      calendarId: WORK,
      instances: [instance("a", 0)],
    });
    expect(same).toBe(loaded);
  });
});

describe("mergeCalendarChunks", () => {
  it("lists an event spanning two chunks once", () => {
    const first = new Map([["work/a", instance("a", 0)]]);
    const second = new Map([
      ["work/a", instance("a", 0)],
      ["work/b", instance("b", 5)],
    ]);
    const merged = mergeCalendarChunks([first, second]);
    expect(merged.map((entry) => entry.eventId)).toEqual(["a", "b"]);
    expect(merged[0]).toBe(first.get("work/a"));
  });
});

describe("shareCalendarDirectory", () => {
  const directory: CalendarDirectory = {
    accounts: [
      {
        accountId: CalendarAccountId.make("acc"),
        provider: "demo",
        email: "a@example.com",
        displayName: "A",
        status: "ok",
        lastSyncedAt: 1,
        position: 0,
      },
    ],
    calendars: [
      {
        calendarId: WORK,
        accountId: CalendarAccountId.make("acc"),
        name: "Work",
        color: "#3366ff",
        accessRole: "owner",
        primary: true,
        visible: true,
      },
    ],
    preferences: DEFAULT_CALENDAR_PREFERENCES,
    google: { configured: false, source: null, clientId: null },
  };

  it("reuses unchanged parts so a sync tick does not touch the calendars", () => {
    const synced = shareCalendarDirectory(
      directory,
      structuredClone({
        ...directory,
        accounts: [{ ...directory.accounts[0]!, lastSyncedAt: 2 }],
      }),
    );
    expect(synced).not.toBe(directory);
    expect(synced.calendars).toBe(directory.calendars);
    expect(synced.preferences).toBe(directory.preferences);
    expect(synced.accounts[0]?.lastSyncedAt).toBe(2);

    expect(shareCalendarDirectory(directory, structuredClone(directory))).toBe(directory);
  });
});
