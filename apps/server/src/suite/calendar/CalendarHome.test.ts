import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { calendarEventKey, type CalendarId } from "@t3tools/contracts";
import { DAY_MS, fromZoned, parseDayNumber } from "@t3tools/shared/calendar/time";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { CalendarService } from "../../calendar/CalendarService.ts";
import * as CalendarServiceLive from "../../calendar/CalendarServiceLive.ts";
import * as GoogleAuthUnavailable from "../../calendar/GoogleAuthUnavailable.ts";
import { INVITATION_HORIZON_DAYS, makeCalendarHomeContributor } from "./CalendarHome.ts";
import { SqlitePersistenceMemory } from "./testing/calendarTestDatabase.ts";

const ZONE = "Pacific/Kiritimati"; // UTC+14: all-day UTC dates straddle the local day.
const TODAY = "2026-10-01";
const NOW = fromZoned(parseDayNumber(TODAY)!, 12 * 60, ZONE);

const DemoLayer = CalendarServiceLive.layerWith({ demoLatency: false, autoSync: false }).pipe(
  Layer.provide(GoogleAuthUnavailable.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

const withDemo = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const calendar = yield* CalendarService;
  yield* calendar.updatePreferences({ timeZone: ZONE });
  yield* calendar.addDemo({ size: "standard" });
  yield* calendar.sync({});
  return { calendar, home: yield* makeCalendarHomeContributor };
});

describe("Calendar on Home", () => {
  it.effect("lists today's events in the calendar's zone, all-day ones first", () =>
    Effect.gen(function* () {
      const { calendar, home } = yield* withDemo;
      const today = yield* home.today;
      expect(today.length).toBeGreaterThan(0);

      const dayStart = fromZoned(parseDayNumber(TODAY)!, 0, ZONE);
      const dayEnd = dayStart + DAY_MS;
      for (const event of today) {
        const start = Date.parse(event.startsAt);
        const end = Date.parse(event.endsAt);
        if (event.allDay) {
          expect(start <= Date.UTC(2026, 9, 1) && end > Date.UTC(2026, 9, 1)).toBe(true);
        } else {
          expect(start < dayEnd && end > dayStart).toBe(true);
        }
        expect(event.target).toEqual({ route: "/calendar", params: { date: TODAY } });
      }
      const firstTimed = today.findIndex((event) => !event.allDay);
      expect(
        today.slice(firstTimed === -1 ? today.length : firstTimed).every((e) => !e.allDay),
      ).toBe(true);

      // Declined events stay off Home.
      const shown = new Set(today.map((event) => event.id));
      const instances = yield* calendar.listInstances({ start: dayStart, end: dayEnd });
      for (const instance of instances) {
        if (instance.response === "declined") {
          expect(shown.has(calendarEventKey(instance.calendarId, instance.eventId))).toBe(false);
        }
      }
    }).pipe(Effect.provide(DemoLayer)),
  );

  it.effect("asks for unanswered invitations and answers them from Home", () =>
    Effect.gen(function* () {
      const { calendar, home } = yield* withDemo;
      const pending = (yield* calendar.listInstances({
        start: NOW,
        end: NOW + INVITATION_HORIZON_DAYS * DAY_MS,
      })).filter((instance) => instance.response === "needsAction");
      expect(pending.length).toBeGreaterThan(0);

      const items = yield* home.needsYou;
      expect(items.length).toBeGreaterThan(0);
      // One row per series.
      const series = pending.map(
        (instance) => `${instance.calendarId}/${instance.seriesId ?? instance.eventId}`,
      );
      expect(items.length).toBe(new Set(series).size);
      const item = items[0]!;
      expect(item.kind).toBe("calendar.invitation");
      expect(item.actions.map((action) => action.id)).toEqual(["accept", "tentative", "decline"]);

      yield* home.performAction!(item.id, "accept");
      const [calendarId, eventId] = item.id.split("/") as [CalendarId, string];
      const answered = yield* calendar.getEvent({ calendarId, eventId });
      expect(answered.response).toBe("accepted");
      const after = yield* home.needsYou;
      expect(after.some((entry) => entry.id === item.id)).toBe(false);

      const unknown = yield* home.performAction!(item.id, "snooze").pipe(Effect.flip);
      expect(unknown._tag).toBe("SuiteHomeActionError");
    }).pipe(Effect.provide(DemoLayer)),
  );
});
