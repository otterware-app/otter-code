// @effect-diagnostics globalDate:off - Google's RFC 3339 stamps and timeMin are parsed and formatted here.
/**
 * A `CalendarProviderClient` that fakes Google Calendar for demo accounts. Reads come from
 * `demoData` (the first `calendarList.list` and `events.list` return the generated account and
 * a sync token; incremental syncs report no changes). Writes succeed after a short simulated
 * latency and answer like Google would, so the service stores what they return; a write whose
 * resulting title contains the word "fail" fails, to show optimistic rollback.
 *
 * @module DemoProvider
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

import {
  CalendarProviderError,
  type CalendarProviderClient,
  type RemoteAttendee,
  type RemoteEvent,
} from "../providers/CalendarProvider.ts";
import {
  anchorMonday,
  demoAccounts,
  demoCalendarSource,
  demoEventsPage,
  firstDemoDay,
  meetConference,
  randomMeetCode,
  type DemoAccountSpec,
  type DemoCalendarSource,
  type DemoProfile,
} from "./demoData.ts";

const PAGE_SIZE = 2500;
const FAIL_WORD = /\bfail\b/i;
const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

export interface DemoClientOptions {
  readonly profile: DemoProfile;
  readonly seed: number;
  readonly accountIndex: number;
  /** Simulated write latency of 80–150 ms; tests turn it off. */
  readonly latency: boolean;
}

function demoAccount(options: DemoClientOptions): DemoAccountSpec | undefined {
  return demoAccounts(options.profile, options.seed)[options.accountIndex];
}

export function makeDemoClient(options: DemoClientOptions): CalendarProviderClient {
  const account = demoAccount(options);
  const sources = new Map<string, DemoCalendarSource>();

  const sourceFor = (calendarRemoteId: string, anchor: number) => {
    const key = `${anchor}|${calendarRemoteId}`;
    let source = sources.get(key);
    if (source === undefined) {
      const calendar = account?.calendars.find((entry) => entry.remote.id === calendarRemoteId);
      if (account === undefined || calendar === undefined) return undefined;
      source = demoCalendarSource(options.profile, options.seed, account, calendar, anchor);
      sources.clear();
      sources.set(key, source);
    }
    return source;
  };

  const notFound = (what: string) =>
    new CalendarProviderError({ reason: "not_found", detail: `The demo ${what} does not exist.` });

  const simulateLatency = options.latency
    ? Random.nextIntBetween(80, 150).pipe(Effect.flatMap((ms) => Effect.sleep(Duration.millis(ms))))
    : Effect.void;

  /** Answers a write the way Google would, after the latency; fails on the word "fail". */
  const write = <A extends RemoteEvent | void>(result: A) =>
    simulateLatency.pipe(
      Effect.flatMap(() =>
        result !== undefined && FAIL_WORD.test((result as RemoteEvent).summary ?? "")
          ? Effect.fail(
              new CalendarProviderError({
                reason: "failed",
                detail: "The demo calendar refused this change (its title contains “fail”).",
              }),
            )
          : Effect.succeed(result),
      ),
    );

  const stamp = Clock.currentTimeMillis.pipe(Effect.map((now) => new Date(now).toISOString()));

  const randomId = Effect.gen(function* () {
    let id = "";
    for (let index = 0; index < 26; index += 1) {
      id += BASE32HEX[yield* Random.nextIntBetween(0, 31)];
    }
    return id;
  });

  const randomUnit = Effect.gen(function* () {
    const values: Array<number> = [];
    for (let index = 0; index < 10; index += 1) values.push(yield* Random.next);
    let position = 0;
    return () => values[position++ % values.length]!;
  });

  /** Fills in what Google adds on a write: the conference for a create request. */
  const withConference = (event: RemoteEvent) =>
    Effect.gen(function* () {
      if (event.conferenceData?.createRequest === undefined) return event;
      const code = randomMeetCode(yield* randomUnit);
      return { ...event, ...meetConference(code) };
    });

  return {
    listCalendars: ({ syncToken }) =>
      Effect.succeed(
        syncToken !== undefined
          ? { calendars: [], nextSyncToken: syncToken }
          : {
              calendars: account?.calendars.map((calendar) => calendar.remote) ?? [],
              nextSyncToken: "demo-calendars",
            },
      ),

    listEvents: (calendarRemoteId, { syncToken, pageToken, timeMin }) =>
      Effect.gen(function* () {
        if (syncToken !== undefined) return { events: [], nextSyncToken: syncToken };
        const [anchorText, fixedText, dayText] = pageToken?.split(".") ?? [];
        const anchor =
          anchorText !== undefined
            ? Number(anchorText)
            : anchorMonday(yield* Clock.currentTimeMillis);
        const source = sourceFor(calendarRemoteId, anchor);
        if (source === undefined) return yield* notFound("calendar");
        const timeMinMs = timeMin === undefined ? null : Date.parse(timeMin);
        const cursor =
          fixedText !== undefined && dayText !== undefined
            ? { fixed: Number(fixedText), day: Number(dayText) }
            : { fixed: 0, day: firstDemoDay(source, timeMinMs) };
        const page = demoEventsPage(source, cursor, timeMinMs, PAGE_SIZE);
        const zone = account?.timeZone;
        return page.next === null
          ? {
              events: page.events,
              nextSyncToken: `demo.${anchor}`,
              ...(zone ? { timeZone: zone } : {}),
            }
          : {
              events: page.events,
              nextPageToken: `${anchor}.${page.next.fixed}.${page.next.day}`,
              ...(zone ? { timeZone: zone } : {}),
            };
      }),

    getEvent: () => Effect.fail(notFound("event")),

    insertEvent: (_calendarRemoteId, event) =>
      Effect.gen(function* () {
        const now = yield* stamp;
        const id = event.id ?? (yield* randomId);
        const created: RemoteEvent = yield* withConference({
          status: "confirmed",
          ...event,
          id,
          iCalUID: `${id}@google.com`,
          created: now,
          updated: now,
          sequence: 0,
          etag: `"${now}"`,
          eventType: "default",
          organizer: event.organizer ?? {
            email: account?.email ?? "demo@example.com",
            ...(account ? { displayName: account.displayName } : {}),
            self: true,
          },
          creator: { email: account?.email ?? "demo@example.com", self: true },
          ...(event.attendees !== undefined && event.attendees.length > 0
            ? { attendees: withSelfOrganizer(event.attendees, account) }
            : {}),
        });
        return yield* write(created);
      }),

    patchEvent: (_calendarRemoteId, eventId, patch, { current }) =>
      Effect.gen(function* () {
        const now = yield* stamp;
        const { attendeesOmitted, ...fields } = patch;
        const attendees =
          attendeesOmitted === true && patch.attendees !== undefined
            ? mergeResponses(current.attendees ?? [], patch.attendees)
            : (patch.attendees ?? current.attendees);
        const merged: RemoteEvent = yield* withConference({
          ...current,
          ...fields,
          ...(attendees !== undefined ? { attendees } : {}),
          id: eventId,
          updated: now,
          sequence: (current.sequence ?? 0) + 1,
          etag: `"${now}"`,
        });
        return yield* write(stripEmpty(merged));
      }),

    deleteEvent: () => write(undefined),

    moveEvent: (_calendarRemoteId, _eventId, _destination, { current }) =>
      Effect.gen(function* () {
        const now = yield* stamp;
        return yield* write({ ...current, updated: now, etag: `"${now}"` });
      }),

    patchCalendar: () => write(undefined),
  };
}

/** Google adds the organizer as an accepted attendee when an event gets guests. */
function withSelfOrganizer(
  attendees: ReadonlyArray<RemoteAttendee>,
  account: DemoAccountSpec | undefined,
): ReadonlyArray<RemoteAttendee> {
  if (account === undefined || attendees.some((attendee) => attendee.self === true))
    return attendees;
  return [
    {
      email: account.email,
      displayName: account.displayName,
      self: true,
      organizer: true,
      responseStatus: "accepted",
    },
    ...attendees.map((attendee) => ({ responseStatus: "needsAction" as const, ...attendee })),
  ];
}

/** An RSVP patch (`attendeesOmitted`) only changes the named attendees' responses. */
function mergeResponses(
  current: ReadonlyArray<RemoteAttendee>,
  changes: ReadonlyArray<RemoteAttendee>,
): ReadonlyArray<RemoteAttendee> {
  return current.map((attendee) => {
    const change = changes.find(
      (entry) =>
        entry.email.toLowerCase() === attendee.email.toLowerCase() || (entry.self && attendee.self),
    );
    return change?.responseStatus === undefined
      ? attendee
      : { ...attendee, responseStatus: change.responseStatus };
  });
}

/** Drops fields a patch cleared (an empty recurrence stops repeating). */
function stripEmpty(event: RemoteEvent): RemoteEvent {
  if (event.recurrence !== undefined && event.recurrence.length === 0) {
    const { recurrence: _recurrence, ...rest } = event;
    return rest;
  }
  return event;
}
