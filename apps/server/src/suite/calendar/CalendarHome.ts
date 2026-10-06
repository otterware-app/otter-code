/**
 * What Calendar contributes to Home: today's events for the calendar strip, and invitations
 * still waiting for the user's answer in "needs you" (Accept / Maybe / Decline answer them).
 * Everything reads the synced tables through `CalendarService`; nothing here calls Google
 * except an answer the user chose.
 */
import {
  type Calendar,
  type CalendarDirectory,
  type CalendarEventInstance,
  type CalendarId,
  type CalendarResponseStatus,
  calendarEventKey,
} from "@t3tools/contracts";
import {
  SuiteHomeActionError,
  type SuiteHomeItem,
  type SuiteTodayEvent,
} from "@t3tools/contracts/suite";
import {
  DAY_MS,
  formatDayNumber,
  fromZoned,
  isValidTimeZone,
  systemTimeZone,
  zonedDay,
} from "@t3tools/shared/calendar/time";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CalendarService, type CalendarServiceShape } from "../../calendar/CalendarService.ts";
import type { SuiteHomeContributor } from "../SuiteModule.ts";

/** How far ahead unanswered invitations show on Home. */
export const INVITATION_HORIZON_DAYS = 14;

const RSVP_ACTIONS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly response: CalendarResponseStatus;
}> = [
  { id: "accept", label: "Accept", response: "accepted" },
  { id: "tentative", label: "Tentative", response: "tentative" },
  { id: "decline", label: "Decline", response: "declined" },
];

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** The zone the user reads their calendar in: the preference, else the server's. */
export function calendarZone(directory: CalendarDirectory): string {
  const zone = directory.preferences.timeZone;
  return zone !== null && isValidTimeZone(zone) ? zone : systemTimeZone();
}

/** The day `instance` covers in `zone`: all-day events are floating UTC dates. */
const coversDay = (
  instance: CalendarEventInstance,
  day: number,
  dayStart: number,
  dayEnd: number,
) =>
  instance.allDay === true
    ? Math.floor(instance.start / DAY_MS) <= day && day < Math.ceil(instance.end / DAY_MS)
    : instance.start < dayEnd && instance.end > dayStart;

const dayTarget = (day: number) => ({ route: "/calendar", params: { date: formatDayNumber(day) } });

/** The calendar on the day `instance` starts. */
const startTarget = (instance: CalendarEventInstance, zone: string) =>
  dayTarget(
    instance.allDay === true ? Math.floor(instance.start / DAY_MS) : zonedDay(instance.start, zone),
  );

function formatWhen(instance: CalendarEventInstance, zone: string): string {
  const date = new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: instance.allDay === true ? "UTC" : zone,
  }).format(instance.start);
  if (instance.allDay === true) return `${date}, all day`;
  const time = new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: zone,
  });
  return `${date}, ${time.format(instance.start)} – ${time.format(instance.end)}`;
}

const calendarsById = (directory: CalendarDirectory) =>
  new Map<string, Calendar>(directory.calendars.map((calendar) => [calendar.calendarId, calendar]));

/** Today's events in the user's zone, declined ones left out, in start order. */
export const todayEvents = (calendar: CalendarServiceShape, now: number) =>
  Effect.gen(function* () {
    const directory = yield* calendar.getDirectory;
    const zone = calendarZone(directory);
    const day = zonedDay(now, zone);
    const dayStart = fromZoned(day, 0, zone);
    const dayEnd = fromZoned(day + 1, 0, zone);
    // Padded by a day: all-day events are UTC dates, which zones far from UTC straddle.
    const instances = yield* calendar.listInstances({
      start: dayStart - DAY_MS,
      end: dayEnd + DAY_MS,
    });
    const calendars = calendarsById(directory);
    const shown = instances.filter(
      (instance) => instance.response !== "declined" && coversDay(instance, day, dayStart, dayEnd),
    );
    const events: Array<SuiteTodayEvent> = [];
    for (const instance of shown) {
      const details = yield* calendar
        .getEvent({ calendarId: instance.calendarId, eventId: instance.eventId })
        .pipe(Effect.option);
      const owner = calendars.get(instance.calendarId);
      const location = details._tag === "Some" ? details.value.location : instance.location;
      const conferenceUrl = details._tag === "Some" ? details.value.conference?.url : undefined;
      const color = instance.color ?? owner?.color;
      events.push({
        id: calendarEventKey(instance.calendarId, instance.eventId),
        title: instance.title || "(No title)",
        startsAt: isoOf(instance.start),
        endsAt: isoOf(instance.end),
        allDay: instance.allDay === true,
        ...(location ? { location } : {}),
        ...(conferenceUrl ? { conferenceUrl } : {}),
        ...(owner ? { calendarName: owner.name } : {}),
        ...(color ? { color } : {}),
        target: dayTarget(day),
      });
    }
    return events.toSorted(
      (left, right) =>
        Number(right.allDay) - Number(left.allDay) || left.startsAt.localeCompare(right.startsAt),
    );
  });

/** Upcoming invitations the user has not answered; one row per recurring series. */
export const pendingInvitations = (calendar: CalendarServiceShape, now: number) =>
  Effect.gen(function* () {
    const directory = yield* calendar.getDirectory;
    const zone = calendarZone(directory);
    const instances = yield* calendar.listInstances({
      start: now,
      end: now + INVITATION_HORIZON_DAYS * DAY_MS,
    });
    const calendars = calendarsById(directory);
    const seen = new Set<string>();
    const items: Array<SuiteHomeItem> = [];
    for (const instance of instances) {
      if (instance.response !== "needsAction") continue;
      const group = `${instance.calendarId}/${instance.seriesId ?? instance.eventId}`;
      if (seen.has(group)) continue;
      seen.add(group);
      const owner = calendars.get(instance.calendarId);
      const when = formatWhen(instance, zone);
      items.push({
        id: calendarEventKey(instance.calendarId, instance.eventId),
        module: "calendar",
        kind: "calendar.invitation",
        title: `Invitation: ${instance.title || "(No title)"}`,
        subtitle:
          `${when}${instance.seriesId === undefined ? "" : ", repeats"}` +
          (owner ? ` · ${owner.name}` : ""),
        occurredAt: isoOf(instance.start),
        priority: 80,
        actions: RSVP_ACTIONS.map((action) => ({
          id: action.id,
          label: action.label,
          ...(action.id === "accept" ? { primary: true } : {}),
        })),
        target: startTarget(instance, zone),
      });
    }
    return items;
  });

/** `calendarId/eventId` back into its parts; event ids never contain `/`, calendar ids may not either. */
const parseItemId = (itemId: string) => {
  const slash = itemId.indexOf("/");
  return slash <= 0 || slash === itemId.length - 1
    ? null
    : { calendarId: itemId.slice(0, slash) as CalendarId, eventId: itemId.slice(slash + 1) };
};

export const makeCalendarHomeContributor = Effect.gen(function* () {
  const calendar = yield* CalendarService;
  const now = Clock.currentTimeMillis;

  const answer = (itemId: string, actionId: string) => {
    const fail = (cause?: unknown) =>
      new SuiteHomeActionError({
        module: "calendar",
        itemId,
        actionId,
        ...(cause === undefined ? {} : { cause }),
      });
    const ref = parseItemId(itemId);
    const action = RSVP_ACTIONS.find((candidate) => candidate.id === actionId);
    if (ref === null || action === undefined) return Effect.fail(fail());
    return calendar.getEvent(ref).pipe(
      // An invitation to a series is answered for the series, as Google's invitation does.
      Effect.flatMap((event) =>
        calendar.respond({
          ...ref,
          response: action.response,
          scope: event.seriesId === undefined ? "this" : "all",
        }),
      ),
      Effect.asVoid,
      Effect.mapError(fail),
    );
  };

  return {
    module: "calendar",
    needsYou: now.pipe(
      Effect.flatMap((ms) => pendingInvitations(calendar, ms)),
      Effect.catchCause((cause) =>
        Effect.logWarning("Calendar could not list invitations for Home.", cause).pipe(
          Effect.as([]),
        ),
      ),
    ),
    today: now.pipe(
      Effect.flatMap((ms) => todayEvents(calendar, ms)),
      Effect.catchCause((cause) =>
        Effect.logWarning("Calendar could not list today's events for Home.", cause).pipe(
          Effect.as([]),
        ),
      ),
    ),
    performAction: answer,
  } satisfies SuiteHomeContributor;
});
