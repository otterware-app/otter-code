import {
  CalendarError,
  type CalendarDirectory,
  type CalendarEventDetails,
  type CalendarEventInstance,
  type CalendarEventTimeInput,
  type CalendarId,
} from "@t3tools/contracts";
import { describeRecurrence } from "@t3tools/shared/calendar/recurrence";
import {
  DAY_MS,
  MINUTE_MS,
  formatDayNumber,
  formatZonedIso,
  fromZoned,
  isValidTimeZone,
  parseDayNumber,
  parseInstant,
  systemTimeZone,
  zonedDay,
} from "@t3tools/shared/calendar/time";
import * as Effect from "effect/Effect";

import { CalendarService } from "../../../calendar/CalendarService.ts";
import { CalendarToolkit, LIST_EVENTS_LIMIT } from "./tools.ts";

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const invalid = (detail: string) => new CalendarError({ code: "invalid", detail });

/**
 * The zone the user sees the calendar in: the one the agent passes (from the app's context,
 * since the preference may follow each device), else the preferences', else the server's.
 */
function userZone(directory: CalendarDirectory, viewer?: string): string {
  if (viewer !== undefined && isValidTimeZone(viewer)) return viewer;
  const zone = directory.preferences.timeZone;
  return zone !== null && isValidTimeZone(zone) ? zone : systemTimeZone();
}

function eventZoneOf(timeZone: string | undefined, fallback: string): string {
  return timeZone !== undefined && isValidTimeZone(timeZone) ? timeZone : fallback;
}

/** An ISO instant, a wall time in `zone` (no offset), or a bare date (its start in `zone`). */
function parseToolTime(value: string, zone: string): Effect.Effect<number, CalendarError> {
  const day = parseDayNumber(value.trim());
  const ms = day !== null ? fromZoned(day, 0, zone) : parseInstant(value, zone);
  return ms === null
    ? Effect.fail(
        invalid(`Could not read the time "${value}"; use ISO 8601 like 2026-10-01T09:00:00+02:00.`),
      )
    : Effect.succeed(ms);
}

/** The calendar date a value names, for all-day events. */
function parseToolDate(value: string, zone: string): Effect.Effect<number, CalendarError> {
  const day = parseDayNumber(value.trim());
  if (day !== null) return Effect.succeed(day);
  return parseToolTime(value, zone).pipe(Effect.map((ms) => zonedDay(ms, zone)));
}

function formatTime(ms: number, allDay: boolean, zone: string): string {
  return allDay ? formatDayNumber(Math.floor(ms / DAY_MS)) : formatZonedIso(ms, zone);
}

function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function calendarNames(directory: CalendarDirectory): Map<string, string> {
  return new Map(directory.calendars.map((calendar) => [calendar.calendarId, calendar.name]));
}

function entryOf(instance: CalendarEventInstance, names: Map<string, string>, zone: string) {
  const allDay = instance.allDay === true;
  return {
    calendarId: instance.calendarId,
    calendar: names.get(instance.calendarId) ?? "",
    eventId: instance.eventId,
    ...(instance.seriesId !== undefined ? { seriesId: instance.seriesId } : {}),
    title: instance.title === "" ? "(No title)" : instance.title,
    start: formatTime(instance.start, allDay, zone),
    end: formatTime(instance.end, allDay, zone),
    ...(allDay ? { allDay: true } : {}),
    ...(instance.location !== undefined ? { location: instance.location } : {}),
    ...(instance.response !== undefined ? { response: instance.response } : {}),
    ...(instance.free ? { free: true } : {}),
    ...(instance.tentative ? { tentative: true } : {}),
    ...(instance.readOnly ? { readOnly: true } : {}),
  };
}

function detailOf(details: CalendarEventDetails, names: Map<string, string>, zone: string) {
  const allDay = details.allDay === true;
  const organizer = details.organizer;
  return {
    ...entryOf(details, names, zone),
    ...(details.location !== undefined ? { location: details.location } : {}),
    ...(details.timeZone !== undefined ? { timeZone: details.timeZone } : {}),
    description: details.description,
    ...(details.recurrence !== undefined
      ? {
          repeats: describeRecurrence(details.recurrence, {
            start: details.originalStart ?? details.start,
            allDay,
            timeZone: details.timeZone ?? zone,
          }),
          recurrence: details.recurrence,
        }
      : {}),
    ...(organizer !== undefined
      ? {
          organizer: organizer.displayName
            ? `${organizer.displayName} <${organizer.email}>`
            : organizer.email,
        }
      : {}),
    attendees: details.attendees.map((attendee) => ({
      email: attendee.email,
      ...(attendee.displayName ? { name: attendee.displayName } : {}),
      response: attendee.responseStatus,
      ...(attendee.organizer ? { organizer: true } : {}),
      ...(attendee.self ? { self: true } : {}),
      ...(attendee.optional ? { optional: true } : {}),
    })),
    ...(details.conference !== undefined ? { videoCall: details.conference.url } : {}),
    canRespond: details.canRespond,
    ...(details.htmlLink !== undefined ? { link: details.htmlLink } : {}),
  };
}

export const CalendarHandlersLive = CalendarToolkit.toLayer(
  Effect.gen(function* () {
    const calendar = yield* CalendarService;

    const withDetail = (event: CalendarEventDetails | undefined, viewer?: string) =>
      calendar.getDirectory.pipe(
        Effect.map((directory) =>
          event === undefined
            ? {}
            : { event: detailOf(event, calendarNames(directory), userZone(directory, viewer)) },
        ),
      );

    return {
      calendar_list_accounts: ({ timeZone }) =>
        calendar.getDirectory.pipe(
          Effect.map((directory) => ({
            timeZone: userZone(directory, timeZone),
            workingHours: {
              start: formatMinutes(directory.preferences.workingHours.start),
              end: formatMinutes(directory.preferences.workingHours.end),
              days: directory.preferences.workingHours.days.map((day) => WEEKDAY_NAMES[day] ?? ""),
            },
            accounts: directory.accounts.map((account) => ({
              accountId: account.accountId,
              email: account.email,
              provider: account.provider,
              status: account.status,
              ...(account.error !== undefined ? { error: account.error } : {}),
              calendars: directory.calendars
                .filter((entry) => entry.accountId === account.accountId)
                .map((entry) => ({
                  calendarId: entry.calendarId,
                  name: entry.name,
                  color: entry.color,
                  visible: entry.visible,
                  accessRole: entry.accessRole,
                  primary: entry.primary,
                })),
            })),
          })),
        ),

      calendar_list_events: ({ start, end, calendarIds, query, timeZone }) =>
        Effect.gen(function* () {
          yield* calendar.ensureFresh;
          const directory = yield* calendar.getDirectory;
          const zone = userZone(directory, timeZone);
          const instances = yield* calendar.listInstances({
            start: yield* parseToolTime(start, zone),
            end: yield* parseToolTime(end, zone),
            ...(calendarIds !== undefined ? { calendarIds } : {}),
          });
          const needle = query?.trim().toLowerCase() ?? "";
          const matching =
            needle === ""
              ? instances
              : instances.filter(
                  (instance) =>
                    instance.title.toLowerCase().includes(needle) ||
                    (instance.location?.toLowerCase().includes(needle) ?? false),
                );
          const names = calendarNames(directory);
          return {
            timeZone: zone,
            events: matching
              .slice(0, LIST_EVENTS_LIMIT)
              .map((instance) => entryOf(instance, names, zone)),
            truncated: matching.length > LIST_EVENTS_LIMIT,
          };
        }),

      calendar_search_events: ({ query, limit, timeZone }) =>
        Effect.gen(function* () {
          if (query.trim() === "") return yield* invalid("Search for at least one character.");
          yield* calendar.ensureFresh;
          const directory = yield* calendar.getDirectory;
          const zone = userZone(directory, timeZone);
          const found = yield* calendar.search({
            query: query.trim().slice(0, 200),
            limit: Math.max(1, Math.min(200, Math.round(limit ?? 25))),
          });
          const names = calendarNames(directory);
          return {
            timeZone: zone,
            events: found.results.map((instance) => entryOf(instance, names, zone)),
          };
        }),

      calendar_get_event: ({ calendarId, eventId, timeZone }) =>
        Effect.gen(function* () {
          yield* calendar.ensureFresh;
          const details = yield* calendar.getEvent({ calendarId, eventId });
          const directory = yield* calendar.getDirectory;
          return detailOf(details, calendarNames(directory), userZone(directory, timeZone));
        }),

      calendar_create_event: ({ calendarId, start, end, allDay, timeZone, ...fields }) =>
        Effect.gen(function* () {
          const directory = yield* calendar.getDirectory;
          const zone = eventZoneOf(timeZone, userZone(directory));
          let time: CalendarEventTimeInput;
          if (allDay === true) {
            const first = yield* parseToolDate(start, zone);
            // An end on the start date means that one day (agents often pass inclusive ends).
            const last =
              end === undefined ? first + 1 : Math.max(first + 1, yield* parseToolDate(end, zone));
            time = { allDay: true, start: formatDayNumber(first), end: formatDayNumber(last) };
          } else {
            const startMs = yield* parseToolTime(start, zone);
            const endMs =
              end === undefined
                ? startMs + directory.preferences.defaultEventMinutes * MINUTE_MS
                : yield* parseToolTime(end, zone);
            time = {
              allDay: false,
              start: formatZonedIso(startMs, zone),
              end: formatZonedIso(endMs, zone),
              timeZone: zone,
            };
          }
          const result = yield* calendar.createEvent({ calendarId, time, ...fields });
          return yield* withDetail(result.event, timeZone);
        }),

      calendar_update_event: ({ calendarId, eventId, start, end, allDay, timeZone, ...fields }) =>
        Effect.gen(function* () {
          let time: CalendarEventTimeInput | undefined;
          if (start !== undefined || end !== undefined || allDay !== undefined) {
            const current = yield* calendar.getEvent({ calendarId, eventId });
            const directory = yield* calendar.getDirectory;
            const zone = eventZoneOf(timeZone ?? current.timeZone, userZone(directory));
            const wasAllDay = current.allDay === true;
            const toAllDay = allDay ?? wasAllDay;
            if (toAllDay) {
              const currentDay = wasAllDay
                ? Math.floor(current.start / DAY_MS)
                : zonedDay(current.start, zone);
              const first = start === undefined ? currentDay : yield* parseToolDate(start, zone);
              const days = wasAllDay
                ? Math.max(1, Math.round((current.end - current.start) / DAY_MS))
                : 1;
              const last = end === undefined ? first + days : yield* parseToolDate(end, zone);
              time = { allDay: true, start: formatDayNumber(first), end: formatDayNumber(last) };
            } else {
              const currentStart = wasAllDay
                ? fromZoned(Math.floor(current.start / DAY_MS), 9 * 60, zone)
                : current.start;
              const length = wasAllDay
                ? directory.preferences.defaultEventMinutes * MINUTE_MS
                : current.end - current.start;
              const startMs =
                start === undefined ? currentStart : yield* parseToolTime(start, zone);
              const endMs = end === undefined ? startMs + length : yield* parseToolTime(end, zone);
              time = {
                allDay: false,
                start: formatZonedIso(startMs, zone),
                end: formatZonedIso(endMs, zone),
                timeZone: zone,
              };
            }
          }
          const result = yield* calendar.updateEvent({
            calendarId,
            eventId,
            ...(time !== undefined ? { time } : {}),
            ...fields,
          });
          return yield* withDetail(result.event, timeZone);
        }),

      calendar_delete_event: (input) =>
        calendar.deleteEvent(input).pipe(Effect.as({ deleted: true })),

      calendar_respond_to_invitation: (input) =>
        calendar.respond(input).pipe(Effect.flatMap((result) => withDetail(result.event))),

      calendar_find_free_time: ({
        start,
        end,
        durationMinutes,
        calendarIds,
        accountIds,
        workingHoursOnly,
        timeZone,
      }) =>
        Effect.gen(function* () {
          yield* calendar.ensureFresh;
          const directory = yield* calendar.getDirectory;
          const zone = userZone(directory, timeZone);
          const fromAccounts =
            accountIds === undefined
              ? []
              : directory.calendars
                  .filter((entry) => entry.visible && accountIds.includes(entry.accountId))
                  .map((entry) => entry.calendarId);
          const chosen: Array<CalendarId> | undefined =
            calendarIds === undefined && accountIds === undefined
              ? undefined
              : [...new Set([...(calendarIds ?? []), ...fromAccounts])];
          const slots = yield* calendar.findFreeTime({
            start: yield* parseToolTime(start, zone),
            end: yield* parseToolTime(end, zone),
            durationMinutes,
            ...(chosen !== undefined ? { calendarIds: chosen } : {}),
            ...(workingHoursOnly !== undefined ? { workingHoursOnly } : {}),
            timeZone: zone,
          });
          return {
            timeZone: zone,
            slots: slots.map((slot) => ({
              start: formatZonedIso(slot.start, zone),
              end: formatZonedIso(slot.end, zone),
              minutes: Math.round((slot.end - slot.start) / MINUTE_MS),
            })),
          };
        }),
    };
  }),
);
