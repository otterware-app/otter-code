import {
  CalendarAccountId,
  CalendarId,
  type Calendar,
  type CalendarChangeStep,
  type CalendarEventInstance,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  applyOptimisticCalendars,
  applyOptimisticInstances,
  createCalendarHistory,
  createCalendarOptimisticStore,
  eventTimeInput,
  optimisticChangeForSteps,
  parseEventTimeInput,
} from "./optimistic.ts";

const WORK = CalendarId.make("work");
const HOME = CalendarId.make("home");
const HOUR = 3_600_000;

function instance(eventId: string, start: number, extra: Partial<CalendarEventInstance> = {}) {
  return { calendarId: WORK, eventId, title: eventId, start, end: start + HOUR, ...extra };
}

describe("optimistic overlay", () => {
  it("shows changes at once, later changes win, and settling rolls back", () => {
    const base = [instance("a", 0), instance("b", HOUR)];
    const store = createCalendarOptimisticStore();
    expect(applyOptimisticInstances(base, store.getState())).toBe(base);

    const first = store.apply({ upsert: [instance("a", 2 * HOUR)] });
    const second = store.apply({ upsert: [instance("a", 3 * HOUR)], remove: ["work/b"] });
    const created = store.apply({ upsert: [instance("pending-1", 5 * HOUR)] });
    expect(
      applyOptimisticInstances(base, store.getState()).map((entry) => [entry.eventId, entry.start]),
    ).toEqual([
      ["a", 3 * HOUR],
      ["pending-1", 5 * HOUR],
    ]);
    expect([...store.getState().pendingKeys].sort()).toEqual([
      "work/a",
      "work/b",
      "work/pending-1",
    ]);

    // The first save failed: the second is still in flight, so it keeps showing.
    store.settle(first);
    expect(applyOptimisticInstances(base, store.getState())[0]?.start).toBe(3 * HOUR);
    store.settle(second);
    store.settle(created);
    expect(applyOptimisticInstances(base, store.getState())).toBe(base);
    expect(store.getState().pendingKeys.size).toBe(0);
  });

  it("hides a pending created event once the server's own copy arrives", () => {
    const store = createCalendarOptimisticStore();
    store.apply({ upsert: [instance("pending-7", HOUR, { title: "Lunch" })] });
    const arrived = [instance("real", HOUR, { title: "Lunch" })];
    expect(
      applyOptimisticInstances(arrived, store.getState()).map((entry) => entry.eventId),
    ).toEqual(["real"]);
  });

  it("patches calendar visibility and color until settled", () => {
    const calendars: Calendar[] = [
      {
        calendarId: WORK,
        accountId: CalendarAccountId.make("acc"),
        name: "Work",
        color: "#3366ff",
        accessRole: "owner",
        primary: true,
        visible: true,
      },
    ];
    const store = createCalendarOptimisticStore();
    const id = store.apply({ calendars: [{ calendarId: WORK, visible: false }] });
    expect(applyOptimisticCalendars(calendars, store.getState())[0]?.visible).toBe(false);
    store.settle(id);
    expect(applyOptimisticCalendars(calendars, store.getState())).toBe(calendars);
  });

  it("notifies subscribers once per change", () => {
    const store = createCalendarOptimisticStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);
    const id = store.apply({ remove: ["work/a"] });
    store.settle(id);
    store.settle(id);
    unsubscribe();
    expect(calls).toBe(2);
  });
});

describe("event times", () => {
  it("round-trips all-day dates and zoned instants", () => {
    const allDay = eventTimeInput(
      { start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 9, 3), allDay: true },
      "Europe/Berlin",
    );
    expect(allDay).toEqual({ allDay: true, start: "2026-10-01", end: "2026-10-03" });
    expect(parseEventTimeInput(allDay)).toEqual({
      start: Date.UTC(2026, 9, 1),
      end: Date.UTC(2026, 9, 3),
      allDay: true,
    });

    const start = Date.UTC(2026, 9, 1, 7);
    const timed = eventTimeInput({ start, end: start + HOUR, allDay: false }, "Europe/Berlin");
    expect(timed).toEqual({
      allDay: false,
      start: "2026-10-01T09:00:00+02:00",
      end: "2026-10-01T10:00:00+02:00",
      timeZone: "Europe/Berlin",
    });
    expect(parseEventTimeInput(timed)).toEqual({ start, end: start + HOUR, allDay: false });
  });
});

describe("optimisticChangeForSteps", () => {
  const shown = new Map([
    ["work/a", instance("a", 0)],
    ["work/s_1", instance("s_1", 0, { seriesId: "s" })],
  ]);
  const lookup = (key: string) => shown.get(key);

  it("moves, deletes and creates what the steps describe", () => {
    const steps: CalendarChangeStep[] = [
      {
        _tag: "update",
        input: {
          calendarId: WORK,
          eventId: "a",
          time: { allDay: false, start: "1970-01-01T02:00:00Z", end: "1970-01-01T03:00:00Z" },
          targetCalendarId: HOME,
        },
      },
      {
        _tag: "create",
        input: {
          calendarId: WORK,
          title: "Back",
          time: { allDay: true, start: "2026-10-01", end: "2026-10-02" },
        },
      },
    ];
    const change = optimisticChangeForSteps(steps, lookup);
    expect(change.remove).toEqual(["work/a"]);
    expect(change.upsert?.[0]).toMatchObject({ calendarId: HOME, eventId: "a", start: 2 * HOUR });
    expect(change.upsert?.[1]).toMatchObject({
      title: "Back",
      allDay: true,
      start: Date.UTC(2026, 9, 1),
    });
    expect(
      optimisticChangeForSteps(
        [{ _tag: "delete", input: { calendarId: WORK, eventId: "a" } }],
        lookup,
      ),
    ).toEqual({ remove: ["work/a"] });
  });

  it("leaves series-wide changes and unknown events to the server", () => {
    expect(
      optimisticChangeForSteps(
        [
          {
            _tag: "update",
            input: { calendarId: WORK, eventId: "s_1", scope: "all", title: "All of them" },
          },
          { _tag: "update", input: { calendarId: WORK, eventId: "gone", title: "?" } },
          { _tag: "restore", input: { calendarId: WORK, eventId: "a" } },
        ],
        lookup,
      ),
    ).toEqual({});
  });
});

describe("calendar history", () => {
  const moveBack: CalendarChangeStep = {
    _tag: "update",
    input: { calendarId: WORK, eventId: "a", title: "Old" },
  };
  const moveAgain: CalendarChangeStep = {
    _tag: "update",
    input: { calendarId: WORK, eventId: "a", title: "New" },
  };

  it("undoes into redo, redoes back, and a new change clears redo", async () => {
    const history = createCalendarHistory();
    history.record({ label: "Renamed “New”", steps: [moveBack] });
    const sent: Array<ReadonlyArray<CalendarChangeStep>> = [];

    const undone = await history.undo(async (steps) => {
      sent.push(steps);
      return { ok: true, undo: [moveAgain] };
    });
    expect(undone._tag).toBe("done");
    expect(history.getState()).toEqual({
      undo: [],
      redo: [{ label: "Renamed “New”", steps: [moveAgain] }],
    });

    await history.redo(async (steps) => {
      sent.push(steps);
      return { ok: true, undo: [moveBack] };
    });
    expect(sent).toEqual([[moveBack], [moveAgain]]);
    expect(history.getState().undo).toEqual([{ label: "Renamed “New”", steps: [moveBack] }]);

    history.record({ label: "Other", steps: [moveAgain] });
    expect(history.getState().redo).toEqual([]);
    expect((await createCalendarHistory().undo(async () => ({ ok: true, undo: [] })))._tag).toBe(
      "empty",
    );
  });

  it("keeps an entry that failed to apply so it can be tried again", async () => {
    const history = createCalendarHistory();
    history.record({ label: "Renamed", steps: [moveBack] });
    const failed = await history.undo(async () => ({ ok: false, error: new Error("offline") }));
    expect(failed._tag).toBe("failed");
    expect(history.getState().undo).toHaveLength(1);
    const thrown = await history.undo(() => Promise.reject(new Error("boom")));
    expect(thrown._tag).toBe("failed");
    expect(history.getState().undo).toHaveLength(1);
  });

  it("undo still applies the previous change after a pending mutation rejects", async () => {
    const history = createCalendarHistory();
    history.record({ label: "Renamed", steps: [moveBack] });
    const pending = Promise.withResolvers<void>();
    const mutation = history.trackMutation(() => pending.promise);
    const rejected = expect(mutation).rejects.toThrow("offline");
    const applied: Array<ReadonlyArray<CalendarChangeStep>> = [];
    const undo = history.undo(async (steps) => {
      applied.push(steps);
      return { ok: true, undo: [moveAgain] };
    });
    expect(applied).toEqual([]);
    pending.reject(new Error("offline"));
    await rejected;
    expect((await undo)._tag).toBe("done");
    expect(applied).toEqual([[moveBack]]);
  });
});
