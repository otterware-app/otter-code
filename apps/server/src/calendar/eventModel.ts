/**
 * Pure helpers that read Google-shaped events (`RemoteEvent`): their times, what an instance
 * shows, whether the user may change it, and the detail view. The service stores events as
 * Google returns them and derives everything else here.
 *
 * @module eventModel
 */
import {
  calendarEventKey,
  type CalendarAccessRole,
  type CalendarAttendee,
  type CalendarConference,
  type CalendarEventDetails,
  type CalendarEventInstance,
  type CalendarEventTimeInput,
  type CalendarResponseStatus,
} from "@t3tools/contracts";
import {
  DAY_MS,
  formatDayNumber,
  formatZonedIso,
  isValidTimeZone,
  parseDayNumber,
  parseInstant,
} from "@t3tools/shared/calendar/time";

import type {
  RemoteAttendee,
  RemoteEvent,
  RemoteEventDateTime,
} from "./providers/CalendarProvider.ts";

export const WEEK_MS = 7 * DAY_MS;
const LOCATION_MAX = 60;

export type EventKind = "single" | "master" | "exception";

export function eventKind(event: RemoteEvent): EventKind {
  if (event.recurringEventId !== undefined) return "exception";
  return (event.recurrence?.length ?? 0) > 0 ? "master" : "single";
}

/** A usable zone: the given one when valid, else the fallback. */
export function zoneOr(zone: string | undefined, fallback: string): string {
  return zone !== undefined && zone !== "" && isValidTimeZone(zone) ? zone : fallback;
}

/** An event time as epoch ms; all-day dates at UTC midnight. Null when missing or malformed. */
function parseEventDateTime(
  value: RemoteEventDateTime | undefined,
  fallbackZone: string,
): { readonly ms: number; readonly allDay: boolean } | null {
  if (value === undefined) return null;
  if (value.date !== undefined && value.dateTime === undefined) {
    const day = parseDayNumber(value.date);
    return day === null ? null : { ms: day * DAY_MS, allDay: true };
  }
  if (value.dateTime === undefined) return null;
  const ms = parseInstant(value.dateTime, zoneOr(value.timeZone, fallbackZone));
  return ms === null ? null : { ms, allDay: false };
}

export interface EventTimes {
  readonly start: number;
  readonly end: number;
  readonly allDay: boolean;
  /** The zone the event repeats and displays in (timed events). */
  readonly timeZone: string;
}

/** Start, end and zone of an event; null when its times are unusable. */
export function eventTimes(event: RemoteEvent, fallbackZone: string): EventTimes | null {
  const start = parseEventDateTime(event.start, fallbackZone);
  if (start === null) return null;
  const end = parseEventDateTime(event.end, fallbackZone);
  const endMs =
    end === null || end.allDay !== start.allDay || end.ms < start.ms
      ? start.ms + (start.allDay ? DAY_MS : 0)
      : end.ms;
  return {
    start: start.ms,
    end: endMs,
    allDay: start.allDay,
    timeZone: zoneOr(event.start?.timeZone, fallbackZone),
  };
}

/** When the series scheduled this occurrence (exceptions and instances). */
export function originalStartOf(event: RemoteEvent, fallbackZone: string): number | null {
  return parseEventDateTime(event.originalStartTime, fallbackZone)?.ms ?? null;
}

/** A `start`/`end` value for an instant or all-day date in the event's zone. */
export function toRemoteDateTime(ms: number, allDay: boolean, zone: string): RemoteEventDateTime {
  return allDay
    ? { date: formatDayNumber(Math.floor(ms / DAY_MS)) }
    : { dateTime: formatZonedIso(ms, zone), timeZone: zone };
}

/** The time input that reproduces an event's current times (for undo steps). */
export function timeInputOf(
  event: RemoteEvent,
  fallbackZone: string,
): CalendarEventTimeInput | null {
  const times = eventTimes(event, fallbackZone);
  if (times === null) return null;
  if (times.allDay) {
    return {
      allDay: true,
      start: formatDayNumber(Math.floor(times.start / DAY_MS)),
      end: formatDayNumber(Math.floor(times.end / DAY_MS)),
    };
  }
  return {
    allDay: false,
    start: formatZonedIso(times.start, times.timeZone),
    end: formatZonedIso(times.end, times.timeZone),
    timeZone: times.timeZone,
  };
}

export type ParsedTimeInput =
  | {
      readonly ok: true;
      readonly start: number;
      readonly end: number;
      readonly allDay: boolean;
      readonly zone: string;
    }
  | { readonly ok: false; readonly detail: string };

/** Validates a time input; strings without an offset are wall times in `zone`. */
export function parseTimeInput(input: CalendarEventTimeInput, zone: string): ParsedTimeInput {
  const eventZone = zoneOr(input.timeZone, zone);
  if (input.allDay) {
    const start = parseDayNumber(input.start);
    const end = parseDayNumber(input.end);
    if (start === null || end === null) {
      return { ok: false, detail: "All-day events need dates like 2026-10-01." };
    }
    if (end <= start) return { ok: false, detail: "An event has to end after it starts." };
    return { ok: true, start: start * DAY_MS, end: end * DAY_MS, allDay: true, zone: eventZone };
  }
  const start = parseInstant(input.start, eventZone);
  const end = parseInstant(input.end, eventZone);
  if (start === null || end === null) {
    return { ok: false, detail: "Times need to be ISO 8601, like 2026-10-01T09:00:00+02:00." };
  }
  if (end <= start) return { ok: false, detail: "An event has to end after it starts." };
  return { ok: true, start, end, allDay: false, zone: eventZone };
}

// ── The user's role in an event ──────────────────────────────────────

export function selfAttendee(event: RemoteEvent): RemoteAttendee | undefined {
  return event.attendees?.find((attendee) => attendee.self === true);
}

/** The user organizes it: the organizer is this calendar, or nobody is named. */
function isOrganizer(event: RemoteEvent): boolean {
  return event.organizer === undefined || event.organizer.self === true;
}

/** The user is invited (an attendee who does not organize it) and can answer. */
export function canRespond(event: RemoteEvent): boolean {
  const self = selfAttendee(event);
  return self !== undefined && self.organizer !== true && !isOrganizer(event);
}

export function isReadOnlyRole(role: CalendarAccessRole): boolean {
  return role === "reader" || role === "freeBusyReader";
}

/** Whether the user may move, resize or edit the event (answering stays possible). */
export function isReadOnly(event: RemoteEvent, role: CalendarAccessRole): boolean {
  if (isReadOnlyRole(role)) return true;
  if (event.locked === true || event.privateCopy === true) return true;
  return canRespond(event) && event.guestsCanModify !== true;
}

// ── What an instance shows ───────────────────────────────────────────

export const FLAG_ALL_DAY = 1;
const FLAG_TENTATIVE = 2;
export const FLAG_FREE = 4;
const FLAG_MEET = 8;
export const FLAG_READ_ONLY = 16;

/** Google Calendar's event colors by `colorId`, as its web app shows them. */
const EVENT_COLORS: Readonly<Record<string, string>> = {
  "1": "#7986cb",
  "2": "#33b679",
  "3": "#8e24aa",
  "4": "#e67c73",
  "5": "#f6bf26",
  "6": "#f4511e",
  "7": "#039be5",
  "8": "#616161",
  "9": "#3f51b5",
  "10": "#0b8043",
  "11": "#d50000",
};

function eventColor(colorId: string | undefined): string | null {
  return colorId === undefined ? null : (EVENT_COLORS[colorId] ?? null);
}

function shortLocation(location: string | undefined): string | null {
  const line = location?.split("\n")[0]?.trim() ?? "";
  if (line === "") return null;
  return line.length > LOCATION_MAX ? `${line.slice(0, LOCATION_MAX - 1)}…` : line;
}

function conferenceOf(event: RemoteEvent): CalendarConference | undefined {
  const entries = event.conferenceData?.entryPoints ?? [];
  const video = entries.find((entry) => entry.entryPointType === "video" && entry.uri);
  const url = video?.uri ?? event.hangoutLink;
  if (url === undefined || url === "") return undefined;
  const phone = entries.find((entry) => entry.entryPointType === "phone");
  const details = [
    phone?.label ? `Dial-in: ${phone.label}${phone.pin ? ` (PIN ${phone.pin})` : ""}` : null,
    video?.meetingCode ? `Meeting code: ${video.meetingCode}` : null,
  ].filter((line): line is string => line !== null);
  return {
    url,
    name: event.conferenceData?.conferenceSolution?.name ?? "Video call",
    ...(details.length > 0 ? { details: details.join("\n") } : {}),
  };
}

function responseOf(event: RemoteEvent): CalendarResponseStatus | null {
  if (!canRespond(event)) return null;
  return selfAttendee(event)?.responseStatus ?? "needsAction";
}

/** The columns an instance row stores, apart from its identity and times. */
export interface DisplayFields {
  readonly title: string;
  readonly flags: number;
  readonly response: CalendarResponseStatus | null;
  readonly color: string | null;
  readonly location: string | null;
}

export function displayFields(event: RemoteEvent, role: CalendarAccessRole): DisplayFields {
  let flags = 0;
  if (event.status === "tentative") flags |= FLAG_TENTATIVE;
  if (event.transparency === "transparent") flags |= FLAG_FREE;
  if (conferenceOf(event) !== undefined) flags |= FLAG_MEET;
  if (isReadOnly(event, role)) flags |= FLAG_READ_ONLY;
  return {
    title: event.summary ?? (role === "freeBusyReader" ? "Busy" : ""),
    flags,
    response: responseOf(event),
    color: eventColor(event.colorId),
    location: shortLocation(event.location),
  };
}

/** One materialized occurrence, as `calendar_instances` stores it. */
export interface InstanceRow {
  readonly calendarId: string;
  readonly instanceId: string;
  /** The series (master id) or single event it came from. */
  readonly sourceKey: string;
  readonly seriesId: string | null;
  readonly start: number;
  readonly end: number;
  readonly flags: number;
  readonly title: string;
  readonly response: string | null;
  readonly color: string | null;
  readonly location: string | null;
}

export function instanceRow(
  calendarId: string,
  instanceId: string,
  sourceKey: string,
  seriesId: string | null,
  start: number,
  end: number,
  allDay: boolean,
  fields: DisplayFields,
): InstanceRow {
  return {
    calendarId,
    instanceId,
    sourceKey,
    seriesId,
    start,
    end,
    flags: fields.flags | (allDay ? FLAG_ALL_DAY : 0),
    title: fields.title,
    response: fields.response,
    color: fields.color,
    location: fields.location,
  };
}

export function sameInstanceRow(a: InstanceRow, b: InstanceRow): boolean {
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.flags === b.flags &&
    a.title === b.title &&
    a.response === b.response &&
    a.color === b.color &&
    a.location === b.location &&
    a.seriesId === b.seriesId &&
    a.sourceKey === b.sourceKey
  );
}

/** The wire shape: optional fields only when they differ from the default. */
export function toInstance(row: InstanceRow): CalendarEventInstance {
  const instance: {
    -readonly [K in keyof CalendarEventInstance]: CalendarEventInstance[K];
  } = {
    calendarId: row.calendarId as CalendarEventInstance["calendarId"],
    eventId: row.instanceId,
    title: row.title,
    start: row.start,
    end: row.end,
  };
  if (row.seriesId !== null) instance.seriesId = row.seriesId;
  if ((row.flags & FLAG_ALL_DAY) !== 0) instance.allDay = true;
  if ((row.flags & FLAG_TENTATIVE) !== 0) instance.tentative = true;
  if (row.response !== null) instance.response = row.response as CalendarResponseStatus;
  if (row.color !== null) instance.color = row.color;
  if (row.location !== null) instance.location = row.location;
  if ((row.flags & FLAG_FREE) !== 0) instance.free = true;
  if ((row.flags & FLAG_MEET) !== 0) instance.meet = true;
  if ((row.flags & FLAG_READ_ONLY) !== 0) instance.readOnly = true;
  return instance;
}

export function instanceKey(row: { readonly calendarId: string; readonly instanceId: string }) {
  return calendarEventKey(row.calendarId, row.instanceId);
}

// ── Details ──────────────────────────────────────────────────────────

function attendeeOf(attendee: RemoteAttendee): CalendarAttendee {
  return {
    email: attendee.email,
    responseStatus: attendee.responseStatus ?? "needsAction",
    ...(attendee.displayName ? { displayName: attendee.displayName } : {}),
    ...(attendee.optional ? { optional: true } : {}),
    ...(attendee.organizer ? { organizer: true } : {}),
    ...(attendee.self ? { self: true } : {}),
    ...(attendee.resource ? { resource: true } : {}),
  };
}

function epochOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = parseInstant(value);
  return ms === null ? undefined : ms;
}

export interface DetailsContext {
  readonly calendarId: string;
  /** The id the view knows: the instance id for occurrences. */
  readonly eventId: string;
  readonly seriesId: string | null;
  readonly role: CalendarAccessRole;
  readonly times: EventTimes;
  readonly recurrence: ReadonlyArray<string> | undefined;
  readonly originalStart: number | null;
  readonly google: boolean;
}

export function eventDetails(event: RemoteEvent, context: DetailsContext): CalendarEventDetails {
  const row = instanceRow(
    context.calendarId,
    context.eventId,
    context.seriesId ?? context.eventId,
    context.seriesId,
    context.times.start,
    context.times.end,
    context.times.allDay,
    displayFields(event, context.role),
  );
  const conference = conferenceOf(event);
  const createdAt = epochOf(event.created);
  const updatedAt = epochOf(event.updated);
  const location = event.location?.trim();
  return {
    ...toInstance(row),
    description: event.description ?? "",
    ...(location ? { location } : {}),
    ...(context.times.allDay ? {} : { timeZone: context.times.timeZone }),
    ...(context.recurrence !== undefined && context.recurrence.length > 0
      ? { recurrence: context.recurrence }
      : {}),
    ...(context.originalStart !== null ? { originalStart: context.originalStart } : {}),
    ...(event.organizer?.email
      ? {
          organizer: {
            email: event.organizer.email,
            ...(event.organizer.displayName ? { displayName: event.organizer.displayName } : {}),
            ...(event.organizer.self ? { self: true } : {}),
          },
        }
      : {}),
    attendees: (event.attendees ?? []).map(attendeeOf),
    ...(conference ? { conference } : {}),
    ...(context.google && event.htmlLink ? { htmlLink: event.htmlLink } : {}),
    canRespond: canRespond(event),
    ...(event.visibility ? { visibility: event.visibility } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

/** `updated` as epoch ms, to skip sync results older than a local write. */
export function updatedMs(event: RemoteEvent): number | null {
  return epochOf(event.updated) ?? null;
}
