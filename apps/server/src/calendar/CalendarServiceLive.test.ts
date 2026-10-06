// @effect-diagnostics globalDate:off globalDateInEffect:off - Fake Google events carry RFC 3339 stamps like the real API.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  calendarEventKey,
  type CalendarEventInstance,
  type CalendarId,
  type CalendarWeekEvent,
} from "@t3tools/contracts";
import { DAY_MS, fromZoned, parseDayNumber } from "@t3tools/shared/calendar/time";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../suite/calendar/testing/calendarTestDatabase.ts";
import { CalendarService } from "./CalendarService.ts";
import * as CalendarServiceLive from "./CalendarServiceLive.ts";
import { GoogleAuth } from "./google/GoogleAuth.ts";
import * as GoogleAuthUnavailable from "./GoogleAuthUnavailable.ts";
import {
  CalendarProviderError,
  type CalendarProviderClient,
  type RemoteCalendar,
  type RemoteEvent,
} from "./providers/CalendarProvider.ts";

const ZONE = "Europe/Berlin";
/** Thursday, 2026-10-01, 12:00 in Berlin. */
const NOW = Date.UTC(2026, 9, 1, 10, 0);
const WEEK = "2026-09-28";
const NEXT_WEEK = "2026-10-05";
const day = (value: string) => parseDayNumber(value)!;
const at = (date: string, minutes: number) => fromZoned(day(date), minutes, ZONE);
const weekRange = (week: string) => ({ start: day(week) * DAY_MS, end: (day(week) + 7) * DAY_MS });

const DemoLayer = CalendarServiceLive.layerWith({ demoLatency: false, autoSync: false }).pipe(
  Layer.provide(GoogleAuthUnavailable.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

/** Adds the standard demo accounts and waits for their first sync. */
const withDemo = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const calendar = yield* CalendarService;
  yield* calendar.updatePreferences({ timeZone: ZONE });
  yield* calendar.addDemo({ size: "standard" });
  yield* calendar.sync({});
  const directory = yield* calendar.getDirectory;
  const named = (name: string, email = "alex.morgan@northwind.example") => {
    const account = directory.accounts.find((entry) => entry.email === email)!;
    return directory.calendars.find(
      (entry) => entry.accountId === account.accountId && entry.name === name,
    )!;
  };
  return { calendar, directory, work: named("Alex Morgan") };
});

const watchWeek = (week: string) =>
  Effect.gen(function* () {
    const calendar = yield* CalendarService;
    const events = yield* Queue.unbounded<CalendarWeekEvent>();
    yield* Stream.runForEach(calendar.week({ week }), (event) => Queue.offer(events, event)).pipe(
      Effect.forkScoped,
    );
    const first = yield* Queue.take(events);
    return { events, snapshot: first._tag === "snapshot" ? first.instances : [] };
  });

/** Takes stream events until one matches, returning it. */
const takeUntil = <A extends CalendarWeekEvent>(
  events: Queue.Queue<CalendarWeekEvent>,
  match: (event: CalendarWeekEvent) => event is A,
) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(events);
      if (match(event)) return event;
    }
  });

const instancesIn = (calendarId: CalendarId, week: string) =>
  Effect.flatMap(CalendarService, (calendar) =>
    calendar.listInstances({ ...weekRange(week), calendarIds: [calendarId] }),
  );

const standupsOf = (instances: ReadonlyArray<CalendarEventInstance>) =>
  instances.filter((instance) => instance.title.includes("tandup"));

describe("CalendarServiceLive with the standard demo", () => {
  it.effect("syncs the demo accounts into the directory and week chunks", () =>
    Effect.gen(function* () {
      const { directory, work } = yield* withDemo;
      expect(directory.accounts.map((account) => account.status)).toEqual(["ok", "ok", "ok"]);
      expect(directory.calendars).toHaveLength(10);
      expect(directory.preferences.timeZone).toBe(ZONE);
      expect(
        directory.calendars.find((entry) => entry.name === "Holidays in Germany")?.accessRole,
      ).toBe("reader");

      const { snapshot } = yield* watchWeek(WEEK);
      const standups = standupsOf(snapshot).filter((entry) => entry.calendarId === work.calendarId);
      expect(standups.map((entry) => entry.start).sort()).toEqual(
        [
          at("2026-09-28", 570),
          at("2026-09-29", 570),
          at("2026-09-30", 615),
          at("2026-10-01", 570),
          at("2026-10-02", 570),
        ].sort(),
      );
      expect(standups.find((entry) => entry.start === at("2026-09-30", 615))?.title).toBe(
        "Daily standup (moved)",
      );
      expect(snapshot.find((entry) => entry.title === "Day of German Unity")).toMatchObject({
        allDay: true,
        start: day("2026-10-03") * DAY_MS,
        readOnly: true,
      });
      expect(snapshot.find((entry) => entry.title === "Vendor demo: Globex")).toMatchObject({
        response: "declined",
        readOnly: true,
      });
      expect(snapshot.find((entry) => entry.title === "Lunch")).toMatchObject({ free: true });
      // Every instance overlaps the week and is sent at most once.
      const { start, end } = weekRange(WEEK);
      expect(snapshot.every((entry) => entry.start < end && entry.end > start)).toBe(true);
      const keys = snapshot.map((entry) => calendarEventKey(entry.calendarId, entry.eventId));
      expect(new Set(keys).size).toBe(keys.length);
    }).pipe(Effect.provide(DemoLayer)),
  );

  it.effect("sends diffs to open weeks and replaces a calendar when it is hidden or shown", () =>
    Effect.gen(function* () {
      const { calendar, work } = yield* withDemo;
      const { events } = yield* watchWeek(WEEK);

      const created = yield* calendar.createEvent({
        calendarId: work.calendarId,
        title: "Coffee with Sam",
        time: {
          allDay: false,
          start: "2026-10-01T15:00:00+02:00",
          end: "2026-10-01T15:30:00+02:00",
        },
      });
      const upserted = yield* takeUntil(events, (event) => event._tag === "upserted");
      expect(upserted.instances).toEqual([
        expect.objectContaining({ eventId: created.event?.eventId, title: "Coffee with Sam" }),
      ]);

      yield* calendar.updateEvent({
        calendarId: work.calendarId,
        eventId: created.event!.eventId,
        time: {
          allDay: false,
          start: "2026-10-12T15:00:00+02:00",
          end: "2026-10-12T15:30:00+02:00",
        },
      });
      const removed = yield* takeUntil(events, (event) => event._tag === "removed");
      expect(removed.keys).toEqual([calendarEventKey(work.calendarId, created.event!.eventId)]);

      yield* calendar.updateCalendar({ calendarId: work.calendarId, visible: false });
      const hidden = yield* takeUntil(events, (event) => event._tag === "calendarReplaced");
      expect(hidden).toEqual({
        _tag: "calendarReplaced",
        calendarId: work.calendarId,
        instances: [],
      });

      yield* calendar.updateCalendar({
        calendarId: work.calendarId,
        visible: true,
        color: "#123456",
      });
      const shown = yield* takeUntil(events, (event) => event._tag === "calendarReplaced");
      expect(standupsOf(shown.instances)).toHaveLength(5);
      const directory = yield* calendar.getDirectory;
      expect(
        directory.calendars.find((entry) => entry.calendarId === work.calendarId),
      ).toMatchObject({
        visible: true,
        color: "#123456",
      });
    }).pipe(Effect.provide(DemoLayer)),
  );

  it.effect("edits one occurrence, all of them, or this and following, and undoes each", () =>
    Effect.gen(function* () {
      const { calendar, work } = yield* withDemo;
      const standups = standupsOf(yield* instancesIn(work.calendarId, WEEK));
      const seriesId = standups[0]!.seriesId!;
      const occurrenceOn = (instances: ReadonlyArray<CalendarEventInstance>, date: string) =>
        instances.find(
          (entry) => entry.start >= day(date) * DAY_MS && entry.start < (day(date) + 1) * DAY_MS,
        )!;

      // This occurrence.
      const tuesday = occurrenceOn(standups, "2026-09-29");
      const renamed = yield* calendar.updateEvent({
        calendarId: work.calendarId,
        eventId: tuesday.eventId,
        scope: "this",
        title: "Standup with design",
      });
      expect(renamed.event).toMatchObject({
        eventId: tuesday.eventId,
        title: "Standup with design",
      });
      expect(renamed.undo).toEqual([
        {
          _tag: "update",
          input: {
            calendarId: work.calendarId,
            eventId: tuesday.eventId,
            scope: "this",
            title: "Daily standup",
          },
        },
      ]);
      const undone = yield* calendar.applyChanges({ steps: renamed.undo });
      expect(undone.event?.title).toBe("Daily standup");
      expect(undone.undo).toEqual([
        {
          _tag: "update",
          input: {
            calendarId: work.calendarId,
            eventId: tuesday.eventId,
            scope: "this",
            title: "Standup with design",
          },
        },
      ]);

      // All occurrences, moving the Thursday one to 10:00 moves the whole series.
      const thursday = occurrenceOn(standups, "2026-10-01");
      const moved = yield* calendar.updateEvent({
        calendarId: work.calendarId,
        eventId: thursday.eventId,
        scope: "all",
        time: {
          allDay: false,
          start: "2026-10-01T10:00:00+02:00",
          end: "2026-10-01T10:15:00+02:00",
        },
      });
      expect(moved.undo).toHaveLength(1);
      expect(moved.undo[0]).toMatchObject({
        _tag: "update",
        input: { eventId: seriesId, scope: "all" },
      });
      const afterMove = standupsOf(yield* instancesIn(work.calendarId, WEEK));
      expect(occurrenceOn(afterMove, "2026-10-02").start).toBe(at("2026-10-02", 600));
      yield* calendar.applyChanges({ steps: moved.undo });
      const afterUndo = standupsOf(yield* instancesIn(work.calendarId, WEEK));
      expect(occurrenceOn(afterUndo, "2026-10-02").start).toBe(at("2026-10-02", 570));

      // This and following, from next Thursday: a new series continues from there.
      const nextWeek = standupsOf(yield* instancesIn(work.calendarId, NEXT_WEEK));
      const nextThursday = occurrenceOn(nextWeek, "2026-10-08");
      const split = yield* calendar.updateEvent({
        calendarId: work.calendarId,
        eventId: nextThursday.eventId,
        scope: "following",
        title: "Standup v2",
      });
      const splitWeek = standupsOf(yield* instancesIn(work.calendarId, NEXT_WEEK));
      expect(splitWeek.map((entry) => entry.title)).toEqual([
        "Daily standup",
        "Daily standup",
        "Daily standup",
        "Standup v2",
        "Standup v2",
      ]);
      expect(splitWeek[3]!.seriesId).not.toBe(seriesId);
      const later = standupsOf(yield* instancesIn(work.calendarId, "2026-10-12"));
      expect(later.every((entry) => entry.title === "Standup v2")).toBe(true);
      expect(split.undo.map((step) => step._tag)).toEqual(["delete", "update"]);
      const redo = yield* calendar.applyChanges({ steps: split.undo });
      expect(redo.undo.map((step) => step._tag)).toEqual(["update", "restore"]);
      // Back to the original series, whose Friday occurrence next week is cancelled.
      const restored = standupsOf(yield* instancesIn(work.calendarId, NEXT_WEEK));
      expect(restored.map((entry) => [entry.title, entry.seriesId])).toEqual(
        Array.from({ length: 4 }, () => ["Daily standup", seriesId]),
      );

      // Deleting this and following ends the series; undo brings it back.
      const nextWednesday = occurrenceOn(restored, "2026-10-07");
      const ended = yield* calendar.deleteEvent({
        calendarId: work.calendarId,
        eventId: nextWednesday.eventId,
        scope: "following",
      });
      expect(standupsOf(yield* instancesIn(work.calendarId, NEXT_WEEK))).toHaveLength(2);
      yield* calendar.applyChanges({ steps: ended.undo });
      expect(standupsOf(yield* instancesIn(work.calendarId, NEXT_WEEK))).toHaveLength(4);

      // Deleting one occurrence and restoring it.
      const monday = occurrenceOn(afterUndo, "2026-09-28");
      const deleted = yield* calendar.deleteEvent({
        calendarId: work.calendarId,
        eventId: monday.eventId,
        scope: "this",
      });
      expect(deleted.event).toBeUndefined();
      expect(deleted.undo).toEqual([
        { _tag: "restore", input: { calendarId: work.calendarId, eventId: monday.eventId } },
      ]);
      expect(standupsOf(yield* instancesIn(work.calendarId, WEEK))).toHaveLength(4);
      const back = yield* calendar.applyChanges({ steps: deleted.undo });
      expect(back.event?.eventId).toBe(monday.eventId);
      expect(standupsOf(yield* instancesIn(work.calendarId, WEEK))).toHaveLength(5);
    }).pipe(Effect.provide(DemoLayer)),
  );

  it.effect(
    "answers invitations, keeps others' events read-only, and fails demo writes on fail",
    () =>
      Effect.gen(function* () {
        const { calendar, work } = yield* withDemo;
        const [review] = (yield* calendar.search({ query: "Quarterly business review" })).results;
        expect(review).toMatchObject({ response: "needsAction", readOnly: true });

        const answered = yield* calendar.respond({
          calendarId: review!.calendarId,
          eventId: review!.eventId,
          response: "accepted",
        });
        expect(answered.event?.response).toBe("accepted");
        expect(answered.event?.attendees.length).toBeGreaterThan(2);
        yield* calendar.applyChanges({ steps: answered.undo });
        const reverted = yield* calendar.getEvent({
          calendarId: review!.calendarId,
          eventId: review!.eventId,
        });
        expect(reverted.response).toBe("needsAction");

        const readOnly = yield* Effect.flip(
          calendar.updateEvent({
            calendarId: review!.calendarId,
            eventId: review!.eventId,
            title: "Mine",
          }),
        );
        expect(readOnly.code).toBe("read_only");

        const failing = yield* Effect.flip(
          calendar.createEvent({
            calendarId: work.calendarId,
            title: "This will fail",
            time: { allDay: true, start: "2026-10-02", end: "2026-10-03" },
          }),
        );
        expect(failing.code).toBe("failed");
      }).pipe(Effect.provide(DemoLayer)),
  );

  it.effect("creates, deletes and restores an event through undo and redo", () =>
    Effect.gen(function* () {
      const { calendar, work } = yield* withDemo;
      const created = yield* calendar.createEvent({
        calendarId: work.calendarId,
        title: "Weekly review",
        location: "Room Atlas",
        addConference: true,
        recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
        time: {
          allDay: false,
          start: "2026-10-02T16:00:00+02:00",
          end: "2026-10-02T16:30:00+02:00",
        },
      });
      expect(created.event).toMatchObject({ title: "Weekly review", meet: true });
      expect(created.event?.conference?.url).toMatch(/^https:\/\/meet\.google\.com\//);
      const found = (yield* calendar.search({ query: "weekly review" })).results;
      expect(found).toHaveLength(1);

      const undone = yield* calendar.applyChanges({ steps: created.undo });
      expect((yield* calendar.search({ query: "weekly review" })).results).toHaveLength(0);
      expect(undone.undo.map((step) => step._tag)).toEqual(["restore"]);
      yield* calendar.applyChanges({ steps: undone.undo });
      const weekly = (yield* calendar.listInstances({ start: NOW, end: NOW + 21 * DAY_MS })).filter(
        (entry) => entry.title === "Weekly review",
      );
      expect(weekly).toHaveLength(3);
    }).pipe(Effect.provide(DemoLayer)),
  );

  it.effect("moves an event to another calendar of the account and back through undo", () =>
    Effect.gen(function* () {
      const { calendar, directory, work } = yield* withDemo;
      const team = directory.calendars.find((entry) => entry.name === "Team Northwind")!;
      const personal = directory.calendars.find((entry) => entry.name === "Family")!;
      const created = yield* calendar.createEvent({
        calendarId: work.calendarId,
        title: "Offsite prep",
        time: {
          allDay: false,
          start: "2026-10-02T11:00:00+02:00",
          end: "2026-10-02T12:00:00+02:00",
        },
      });
      const eventId = created.event!.eventId;

      const crossAccount = yield* Effect.flip(
        calendar.updateEvent({
          calendarId: work.calendarId,
          eventId,
          targetCalendarId: personal.calendarId,
        }),
      );
      expect(crossAccount.code).toBe("invalid");

      const moved = yield* calendar.updateEvent({
        calendarId: work.calendarId,
        eventId,
        targetCalendarId: team.calendarId,
        title: "Offsite prep (team)",
      });
      expect(moved.event).toMatchObject({
        calendarId: team.calendarId,
        title: "Offsite prep (team)",
      });
      expect(moved.undo).toEqual([
        {
          _tag: "update",
          input: {
            calendarId: team.calendarId,
            eventId,
            scope: "all",
            targetCalendarId: work.calendarId,
            title: "Offsite prep",
          },
        },
      ]);
      expect(
        (yield* instancesIn(work.calendarId, WEEK)).some((entry) => entry.eventId === eventId),
      ).toBe(false);

      yield* calendar.applyChanges({ steps: moved.undo });
      const back = (yield* instancesIn(work.calendarId, WEEK)).find(
        (entry) => entry.eventId === eventId,
      );
      expect(back?.title).toBe("Offsite prep");
      expect(
        (yield* instancesIn(team.calendarId, WEEK)).some((entry) => entry.eventId === eventId),
      ).toBe(false);
    }).pipe(Effect.provide(DemoLayer)),
  );

  it.effect("removes an account with its calendars and events", () =>
    Effect.gen(function* () {
      const { calendar, directory, work } = yield* withDemo;
      const { events } = yield* watchWeek(WEEK);
      yield* calendar.removeAccount(work.accountId);
      const after = yield* calendar.getDirectory;
      expect(after.accounts).toHaveLength(directory.accounts.length - 1);
      expect(after.calendars.some((entry) => entry.accountId === work.accountId)).toBe(false);
      const replaced = yield* takeUntil(
        events,
        (event): event is Extract<CalendarWeekEvent, { _tag: "calendarReplaced" }> =>
          event._tag === "calendarReplaced" && event.calendarId === work.calendarId,
      );
      expect(replaced.instances).toEqual([]);
      expect((yield* calendar.search({ query: "Daily standup" })).results).toEqual([]);
    }).pipe(Effect.provide(DemoLayer)),
  );

  it.effect("finds free time across accounts inside working hours", () =>
    Effect.gen(function* () {
      const { calendar } = yield* withDemo;
      const slots = yield* calendar.findFreeTime({
        start: at("2026-10-05", 0),
        end: at("2026-10-06", 0),
        durationMinutes: 30,
        timeZone: ZONE,
      });
      expect(slots.length).toBeGreaterThan(0);
      for (const slot of slots) {
        expect(slot.start).toBeGreaterThanOrEqual(at("2026-10-05", 9 * 60));
        expect(slot.end).toBeLessThanOrEqual(at("2026-10-05", 17 * 60));
        expect(slot.end - slot.start).toBeGreaterThanOrEqual(30 * 60_000);
      }
      // The standup (09:30–09:45) is busy; lunch is marked free and does not count.
      expect(
        slots.some(
          (slot) => slot.start < at("2026-10-05", 585) && slot.end > at("2026-10-05", 570),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(DemoLayer)),
  );
});

// ── Sync against a fake Google ───────────────────────────────────────

interface FakeGoogle {
  readonly client: CalendarProviderClient;
  readonly calls: Array<{ readonly method: string; readonly options: Record<string, unknown> }>;
  readonly failNext: Array<{ readonly method: string; readonly error: CalendarProviderError }>;
  readonly put: (event: RemoteEvent) => void;
  /** Called with every `events.list` call's options, as it happens. */
  readonly onList: Array<(options: Record<string, unknown>) => void>;
}

const PRIMARY: RemoteCalendar = {
  id: "me@example.com",
  summary: "Me",
  backgroundColor: "#9fe1e7",
  accessRole: "owner",
  primary: true,
  timeZone: ZONE,
};

function makeFakeGoogle(pageSize: number): FakeGoogle {
  let version = 0;
  const onList: FakeGoogle["onList"] = [];
  const events: Array<{ event: RemoteEvent; version: number }> = [];
  const calls: FakeGoogle["calls"] = [];
  const failNext: FakeGoogle["failNext"] = [];
  const failure = (method: string) => {
    const index = failNext.findIndex((entry) => entry.method === method);
    return index < 0 ? undefined : failNext.splice(index, 1)[0]!.error;
  };
  const put = (event: RemoteEvent) => {
    version += 1;
    const index = events.findIndex((entry) => entry.event.id === event.id);
    if (index >= 0) events.splice(index, 1);
    events.push({ event, version });
  };
  const unused = () => Effect.die("unused in this test");
  const client: CalendarProviderClient = {
    listCalendars: (options) =>
      Effect.suspend(() => {
        calls.push({ method: "listCalendars", options });
        const error = failure("listCalendars");
        if (error) return Effect.fail(error);
        return Effect.succeed({
          calendars: options.syncToken ? [] : [PRIMARY],
          nextSyncToken: "calendars-1",
        });
      }),
    listEvents: (_calendar, options) =>
      Effect.suspend(() => {
        calls.push({ method: "listEvents", options: { ...options } });
        for (const listener of onList) listener({ ...options });
        const error = failure("listEvents");
        if (error) return Effect.fail(error);
        const since = options.syncToken ? Number(options.syncToken.slice(1)) : -1;
        const matching = events
          .filter((entry) => entry.version > since)
          .filter((entry) => options.syncToken !== undefined || entry.event.status !== "cancelled")
          .map((entry) => entry.event);
        const offset = options.pageToken ? Number(options.pageToken) : 0;
        const page = matching.slice(offset, offset + pageSize);
        return Effect.succeed(
          offset + pageSize < matching.length
            ? { events: page, nextPageToken: String(offset + pageSize) }
            : { events: page, nextSyncToken: `v${version}` },
        );
      }),
    getEvent: unused,
    insertEvent: unused,
    patchEvent: unused,
    deleteEvent: unused,
    moveEvent: unused,
    patchCalendar: unused,
  };
  return { client, calls, failNext, put, onList };
}

const fakeGoogleAuth = (google: FakeGoogle) =>
  Layer.succeed(
    GoogleAuth,
    GoogleAuth.of({
      clientStatus: Effect.succeed({ configured: true, source: "environment", clientId: "test" }),
      setClient: () => Effect.void,
      clearClient: Effect.void,
      clientChanges: Stream.empty,
      connect: () =>
        Stream.make(
          {
            _tag: "waiting",
            flowId: "flow",
            authorizationUrl: "https://accounts.example/auth",
            redirectUri: "http://127.0.0.1:1234",
          } as const,
          { _tag: "exchanging" } as const,
          {
            _tag: "connected",
            identity: { sub: "sub-1", email: "me@example.com", name: "Me" },
          } as const,
        ),
      completeConnect: () => Effect.void,
      client: () => google.client,
      hasTokens: () => Effect.succeed(true),
      removeTokens: () => Effect.void,
    }),
  );

const googleLayer = (google: FakeGoogle) =>
  CalendarServiceLive.layerWith({ demoLatency: false, autoSync: false }).pipe(
    Layer.provide(fakeGoogleAuth(google)),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  );

const scheduledLayer = (google: FakeGoogle) =>
  CalendarServiceLive.layerWith({ demoLatency: false }).pipe(
    Layer.provide(fakeGoogleAuth(google)),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  );

const meeting = (
  id: string,
  date: string,
  minutes: number,
  summary = `Meeting ${id}`,
): RemoteEvent => ({
  id,
  summary,
  updated: new Date(NOW - DAY_MS).toISOString(),
  start: { dateTime: new Date(at(date, minutes)).toISOString(), timeZone: ZONE },
  end: { dateTime: new Date(at(date, minutes + 30)).toISOString(), timeZone: ZONE },
});

describe("CalendarServiceLive sync", () => {
  const google = makeFakeGoogle(2);
  for (const [index, date] of [
    "2026-09-28",
    "2026-09-29",
    "2026-09-30",
    "2026-10-01",
    "2026-10-02",
  ].entries()) {
    google.put(meeting(`m${index}`, date, 600));
  }

  it.effect("pages a full sync, applies incremental changes, and resyncs after 410", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const calendar = yield* CalendarService;
      const states = yield* Stream.runCollect(calendar.connect({}));
      expect(states.map((state) => state._tag)).toEqual(["waiting", "exchanging", "succeeded"]);
      yield* calendar.sync({});

      const full = google.calls.filter((call) => call.method === "listEvents");
      expect(full).toHaveLength(3);
      expect(full[0]!.options).toEqual({ timeMin: new Date(NOW - 364 * DAY_MS).toISOString() });
      expect(full[1]!.options).toMatchObject({ pageToken: "2" });
      const directory = yield* calendar.getDirectory;
      expect(directory.accounts).toEqual([
        expect.objectContaining({
          provider: "google",
          email: "me@example.com",
          status: "ok",
          lastSyncedAt: NOW,
        }),
      ]);
      const calendarId = directory.calendars[0]!.calendarId;
      expect(directory.calendars[0]).toMatchObject({ name: "Me", color: "#9fe1e7", primary: true });

      const { events, snapshot } = yield* watchWeek(WEEK);
      expect(snapshot.map((entry) => entry.title).sort()).toEqual([
        "Meeting m0",
        "Meeting m1",
        "Meeting m2",
        "Meeting m3",
        "Meeting m4",
      ]);

      google.put({
        ...meeting("m1", "2026-09-29", 660),
        summary: "Renamed",
        updated: new Date(NOW).toISOString(),
      });
      google.put({ id: "m2", status: "cancelled" });
      google.put(meeting("m5", "2026-10-02", 780));
      yield* calendar.sync({});
      // Incremental pages repeat the sync token with the page token.
      const incremental = google.calls.filter((call) => call.method === "listEvents").slice(-2);
      expect(incremental.map((call) => call.options)).toEqual([
        { syncToken: "v5" },
        { syncToken: "v5", pageToken: "2" },
      ]);
      const upserted = yield* takeUntil(events, (event) => event._tag === "upserted");
      expect(upserted.instances.map((entry) => entry.title).sort()).toEqual([
        "Meeting m5",
        "Renamed",
      ]);
      const removed = yield* takeUntil(events, (event) => event._tag === "removed");
      expect(removed.keys).toEqual([calendarEventKey(calendarId, "m2")]);

      google.failNext.push({
        method: "listEvents",
        error: new CalendarProviderError({
          reason: "gone",
          detail: "Sync token is no longer valid.",
        }),
      });
      yield* calendar.sync({});
      const [expired, resync] = google.calls
        .filter((call) => call.method === "listEvents")
        .slice(-4);
      expect(expired!.options).toEqual({ syncToken: "v8" });
      expect(resync!.options).toHaveProperty("timeMin");
      const replaced = yield* takeUntil(events, (event) => event._tag === "calendarReplaced");
      expect(replaced.instances.map((entry) => entry.title).sort()).toEqual([
        "Meeting m0",
        "Meeting m3",
        "Meeting m4",
        "Meeting m5",
        "Renamed",
      ]);
    }).pipe(Effect.provide(googleLayer(google))),
  );

  it.effect("backs off on rate limits with a readable error and stops when signed out", () => {
    const flaky = makeFakeGoogle(10);
    flaky.put(meeting("a", "2026-09-29", 600));
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const calendar = yield* CalendarService;
      yield* Stream.runDrain(calendar.connect({}));
      yield* calendar.sync({});
      const rateLimited = () =>
        flaky.failNext.push({
          method: "listCalendars",
          error: new CalendarProviderError({
            reason: "rate_limited",
            detail: "Rate limit exceeded.",
          }),
        });

      rateLimited();
      yield* calendar.sync({});
      let [account] = (yield* calendar.getDirectory).accounts;
      expect(account).toMatchObject({ status: "error" });
      expect(account!.error).toContain("limiting");
      expect(account!.error).toContain("1 minute");

      rateLimited();
      yield* calendar.sync({});
      [account] = (yield* calendar.getDirectory).accounts;
      expect(account!.error).toContain("2 minutes");

      yield* calendar.sync({});
      [account] = (yield* calendar.getDirectory).accounts;
      expect(account).toMatchObject({ status: "ok" });
      expect(account!.error).toBeUndefined();

      flaky.failNext.push({
        method: "listCalendars",
        error: new CalendarProviderError({ reason: "signed_out", detail: "invalid_grant" }),
      });
      yield* calendar.sync({});
      [account] = (yield* calendar.getDirectory).accounts;
      expect(account!.status).toBe("signed_out");
      const callsWhileSignedOut = flaky.calls.length;
      yield* calendar.sync({});
      expect(flaky.calls.length).toBe(callsWhileSignedOut);

      yield* Stream.runDrain(calendar.connect({}));
      yield* calendar.sync({});
      [account] = (yield* calendar.getDirectory).accounts;
      expect(account!.status).toBe("ok");
    }).pipe(Effect.provide(googleLayer(flaky)));
  });

  it.effect("syncs every minute while a client is subscribed", () => {
    const watched = makeFakeGoogle(10);
    watched.put(meeting("a", "2026-09-29", 600));
    // The clock is set before the service starts its schedule, so the schedule starts now.
    const body = Effect.gen(function* () {
      const listed = yield* Queue.unbounded<Record<string, unknown>>();
      watched.onList.push((options) => Queue.offerUnsafe(listed, options));
      const calendar = yield* CalendarService;
      yield* Stream.runDrain(calendar.connect({}));
      yield* calendar.sync({});
      expect(yield* Queue.take(listed)).toHaveProperty("timeMin");
      yield* Queue.clear(listed);

      yield* Stream.runDrain(calendar.directory).pipe(Effect.forkScoped);
      yield* TestClock.adjust("70 seconds");
      expect(yield* Queue.take(listed)).toEqual({ syncToken: "v1" });
      yield* TestClock.adjust("70 seconds");
      expect(yield* Queue.take(listed)).toEqual({ syncToken: "v1" });
    });
    return TestClock.setTime(NOW).pipe(
      Effect.andThen(body.pipe(Effect.provide(scheduledLayer(watched)))),
    );
  });
});
