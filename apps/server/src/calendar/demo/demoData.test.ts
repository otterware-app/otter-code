import { describe, expect, it } from "@effect/vitest";
import { DAY_MS } from "@t3tools/shared/calendar/time";

import { materializeSeries } from "../materialize.ts";
import type { RemoteEvent } from "../providers/CalendarProvider.ts";
import {
  anchorMonday,
  demoAccounts,
  demoCalendarSource,
  demoEventsPage,
  firstDemoDay,
  type DemoProfile,
} from "./demoData.ts";

const NOW = Date.UTC(2026, 9, 1, 10);
const ANCHOR = anchorMonday(NOW);
const YEAR_MS = 364 * DAY_MS;

/** Every event of a profile as a first sync with `timeMin = now - 1 year` would list them. */
function listAll(profile: DemoProfile, seed: number) {
  const calendars: Array<{ kind: string; role: string; zone: string; events: Array<RemoteEvent> }> =
    [];
  for (const account of demoAccounts(profile, seed)) {
    for (const calendar of account.calendars) {
      const source = demoCalendarSource(profile, seed, account, calendar, ANCHOR);
      const timeMin = NOW - YEAR_MS;
      let cursor = { fixed: 0, day: firstDemoDay(source, timeMin) };
      const events: Array<RemoteEvent> = [];
      for (;;) {
        const page = demoEventsPage(source, cursor, timeMin, 2500);
        expect(page.events.length).toBeLessThanOrEqual(2500 + 20);
        events.push(...page.events);
        if (page.next === null) break;
        cursor = page.next;
      }
      calendars.push({
        kind: calendar.kind,
        role: calendar.remote.accessRole ?? "owner",
        zone: account.timeZone,
        events,
      });
    }
  }
  return calendars;
}

function countInstances(calendars: ReturnType<typeof listAll>): number {
  let total = 0;
  for (const calendar of calendars) {
    const groups = new Map<string, { master?: RemoteEvent; exceptions: Array<RemoteEvent> }>();
    for (const event of calendar.events) {
      const key = event.recurringEventId ?? event.id;
      const group = groups.get(key) ?? { exceptions: [] };
      groups.set(key, group);
      if (event.recurringEventId !== undefined) group.exceptions.push(event);
      else group.master = event;
    }
    for (const [key, group] of groups) {
      total += materializeSeries({
        calendarId: "calendar",
        key,
        master: group.master,
        exceptions: group.exceptions,
        role: calendar.role as "owner",
        zone: calendar.zone,
        horizon: { start: ANCHOR * DAY_MS - YEAR_MS, end: ANCHOR * DAY_MS + 2 * YEAR_MS },
      }).length;
    }
  }
  return total;
}

describe("demo data", () => {
  it("generates the same standard set for the same seed, and another for another seed", () => {
    const first = listAll("standard", 1);
    const again = listAll("standard", 1);
    const other = listAll("standard", 2);
    expect(again).toEqual(first);
    expect(other.flatMap((calendar) => calendar.events.map((event) => event.id))).not.toEqual(
      first.flatMap((calendar) => calendar.events.map((event) => event.id)),
    );
  });

  it("gives the standard profile three realistic accounts", () => {
    const accounts = demoAccounts("standard", 1);
    expect(accounts.map((account) => account.email)).toEqual([
      "alex.morgan@northwind.example",
      "alex.m.personal@gmail.example",
      "alex@otterware.example",
    ]);
    expect(accounts.flatMap((account) => account.calendars)).toHaveLength(10);
    const calendars = listAll("standard", 1);
    const events = calendars.flatMap((calendar) => calendar.events);
    expect(events.length).toBeGreaterThan(300);
    expect(events.filter((event) => (event.recurrence?.length ?? 0) > 0).length).toBeGreaterThan(
      15,
    );
    expect(events.some((event) => event.status === "cancelled" && event.recurringEventId)).toBe(
      true,
    );
    expect(events.some((event) => event.start?.timeZone === "America/New_York")).toBe(true);
    expect(events.some((event) => event.start?.timeZone === "Asia/Tokyo")).toBe(true);
    expect(events.some((event) => event.hangoutLink?.startsWith("https://meet.google.com/"))).toBe(
      true,
    );
    const responses = new Set(
      events.flatMap((event) =>
        (event.attendees ?? [])
          .filter((attendee) => attendee.self && !attendee.organizer)
          .map((attendee) => attendee.responseStatus),
      ),
    );
    expect([...responses].sort()).toEqual(["accepted", "declined", "needsAction", "tentative"]);
    expect(calendars.find((calendar) => calendar.kind === "holidays")?.role).toBe("reader");
    const instances = countInstances(calendars);
    expect(instances).toBeGreaterThan(2000);
    expect(instances).toBeLessThan(10_000);
  });

  it("gives the massive profile ten accounts and over 100k instances", () => {
    const accounts = demoAccounts("massive", 7);
    expect(accounts).toHaveLength(10);
    expect(accounts.every((account) => account.calendars.length === 4)).toBe(true);
    const calendars = listAll("massive", 7);
    expect(calendars.flatMap((calendar) => calendar.events).length).toBeGreaterThan(90_000);
    expect(countInstances(calendars)).toBeGreaterThanOrEqual(100_000);
  });
});
