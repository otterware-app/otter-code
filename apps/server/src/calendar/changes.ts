/**
 * Pure pieces of changing events: the Google patch an edit sends, the edit that puts the
 * previous values back (undo), the occurrence of a series as Google would return it, and the
 * copy of a master that starts a new series ("this and following").
 *
 * @module changes
 */
import type { CalendarCreateEventInput, CalendarUpdateEventInput } from "@t3tools/contracts";

import { timeInputOf, toRemoteDateTime } from "./eventModel.ts";
import type {
  RemoteAttendee,
  RemoteConferenceData,
  RemoteEvent,
  RemoteEventWrite,
} from "./providers/CalendarProvider.ts";

/** The editable fields shared by create and update inputs. */
export type EventFieldsInput = Pick<
  CalendarUpdateEventInput,
  | "title"
  | "description"
  | "location"
  | "attendees"
  | "recurrence"
  | "addConference"
  | "free"
  | "visibility"
>;

/** A Google Meet (or demo placeholder) request, created with the event. */
function conferenceRequest(requestId: string): RemoteConferenceData {
  return { createRequest: { requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } };
}

function hasConference(event: RemoteEvent): boolean {
  return event.hangoutLink !== undefined || (event.conferenceData?.entryPoints?.length ?? 0) > 0;
}

/**
 * The attendee list for new guest emails: the organizer stays, remaining guests keep their
 * responses, new guests are invited.
 */
function attendeesFor(
  emails: ReadonlyArray<string>,
  current: ReadonlyArray<RemoteAttendee>,
): Array<RemoteAttendee> {
  const wanted = new Map(emails.map((email) => [email.trim().toLowerCase(), email.trim()]));
  const kept = current.filter(
    (attendee) => attendee.organizer === true || wanted.has(attendee.email.toLowerCase()),
  );
  const known = new Set(kept.map((attendee) => attendee.email.toLowerCase()));
  const added = [...wanted]
    .filter(([key]) => !known.has(key))
    .map(([, email]): RemoteAttendee => ({ email, responseStatus: "needsAction" }));
  return [...kept, ...added];
}

/** Guest emails as an update input lists them (the organizer is implied). */
function guestEmails(event: RemoteEvent): Array<string> {
  return (event.attendees ?? [])
    .filter((attendee) => attendee.organizer !== true)
    .map((attendee) => attendee.email);
}

/** The patch for an input's field changes (not its time). */
export function fieldPatch(
  input: EventFieldsInput,
  current: RemoteEvent,
  requestId: () => string,
): RemoteEventWrite {
  const patch: RemoteEventWrite = {};
  if (input.title !== undefined) patch.summary = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.location !== undefined) patch.location = input.location;
  if (input.attendees !== undefined) {
    patch.attendees = attendeesFor(input.attendees, current.attendees ?? []);
  }
  if (input.recurrence !== undefined) patch.recurrence = input.recurrence;
  if (input.addConference === true && !hasConference(current)) {
    patch.conferenceData = conferenceRequest(requestId());
  }
  if (input.free !== undefined) patch.transparency = input.free ? "transparent" : "opaque";
  if (input.visibility !== undefined) patch.visibility = input.visibility;
  return patch;
}

/** The previous values of the fields an input changes, as update input fields. */
function previousFields(
  input: EventFieldsInput,
  previous: RemoteEvent,
): Partial<CalendarUpdateEventInput> {
  const fields: {
    -readonly [K in keyof CalendarUpdateEventInput]?: CalendarUpdateEventInput[K];
  } = {};
  if (input.title !== undefined) fields.title = previous.summary ?? "";
  if (input.description !== undefined) fields.description = previous.description ?? "";
  if (input.location !== undefined) fields.location = previous.location ?? "";
  if (input.attendees !== undefined) fields.attendees = guestEmails(previous);
  if (input.recurrence !== undefined) fields.recurrence = previous.recurrence ?? [];
  if (input.free !== undefined) fields.free = previous.transparency === "transparent";
  if (input.visibility !== undefined) {
    fields.visibility =
      previous.visibility === "confidential" ? "private" : (previous.visibility ?? "default");
  }
  return fields;
}

/** Undo fields including the previous time, when the input changed it. */
export function previousFieldsAndTime(
  input: EventFieldsInput & Pick<CalendarUpdateEventInput, "time">,
  previous: RemoteEvent,
  fallbackZone: string,
): Partial<CalendarUpdateEventInput> {
  const fields = previousFields(input, previous);
  if (input.time === undefined) return fields;
  const time = timeInputOf(previous, fallbackZone);
  return time === null ? fields : { ...fields, time };
}

export function isEmptyPatch(patch: RemoteEventWrite): boolean {
  return Object.keys(patch).length === 0;
}

/** Occurrence `originalStart` of a master as Google's `events.instances` returns it. */
export function occurrenceEvent(
  master: RemoteEvent,
  instanceId: string,
  occurrence: { readonly start: number; readonly end: number },
  allDay: boolean,
  zone: string,
): RemoteEvent {
  const { recurrence: _recurrence, ...rest } = master;
  return {
    ...rest,
    id: instanceId,
    recurringEventId: master.id,
    originalStartTime: toRemoteDateTime(occurrence.start, allDay, zone),
    start: toRemoteDateTime(occurrence.start, allDay, zone),
    end: toRemoteDateTime(occurrence.end, allDay, zone),
  };
}

/** What a new series copies from its original ("this and following"). */
export function seriesCopy(master: RemoteEvent, requestId: () => string): RemoteEventWrite {
  const copy: RemoteEventWrite = {};
  if (master.summary !== undefined) copy.summary = master.summary;
  if (master.description !== undefined) copy.description = master.description;
  if (master.location !== undefined) copy.location = master.location;
  if (master.colorId !== undefined) copy.colorId = master.colorId;
  if (master.transparency !== undefined) copy.transparency = master.transparency;
  if (master.visibility !== undefined) copy.visibility = master.visibility;
  if (master.guestsCanModify !== undefined) copy.guestsCanModify = master.guestsCanModify;
  if (master.attendees !== undefined) copy.attendees = master.attendees;
  // Google asks for a fresh conference per event rather than a copied one.
  if (hasConference(master)) copy.conferenceData = conferenceRequest(requestId());
  return copy;
}

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/**
 * Moves a weekly rule's BYDAY along with its series when "all events" move to another weekday,
 * as Google Calendar does. Other rules are left alone.
 */
export function shiftWeeklyDays(
  recurrence: ReadonlyArray<string>,
  dayDelta: number,
): ReadonlyArray<string> {
  const shift = ((dayDelta % 7) + 7) % 7;
  if (shift === 0) return recurrence;
  return recurrence.map((line) => {
    if (!/^RRULE:/i.test(line) || !/FREQ=WEEKLY/i.test(line)) return line;
    return line.replace(/BYDAY=([A-Z,]+)/i, (_match, days: string) => {
      const shifted = days.split(",").map((code) => {
        const index = WEEKDAY_CODES.indexOf(code.toUpperCase() as (typeof WEEKDAY_CODES)[number]);
        return index < 0 ? code : WEEKDAY_CODES[(index + shift) % 7];
      });
      return `BYDAY=${shifted.join(",")}`;
    });
  });
}

/** A create input as the write Google accepts, minus times. */
export function createWrite(
  input: CalendarCreateEventInput,
  requestId: () => string,
): RemoteEventWrite {
  const write: RemoteEventWrite = { summary: input.title ?? "" };
  if (input.description) write.description = input.description;
  if (input.location) write.location = input.location;
  if (input.attendees !== undefined && input.attendees.length > 0) {
    write.attendees = input.attendees.map((email) => ({ email }));
  }
  if (input.recurrence !== undefined && input.recurrence.length > 0) {
    write.recurrence = input.recurrence;
  }
  if (input.addConference === true) write.conferenceData = conferenceRequest(requestId());
  if (input.free !== undefined) write.transparency = input.free ? "transparent" : "opaque";
  if (input.visibility !== undefined) write.visibility = input.visibility;
  return write;
}

/** The self attendee's new response, as an RSVP patch (`attendeesOmitted`). */
export function withResponse(
  attendees: ReadonlyArray<RemoteAttendee>,
  response: NonNullable<RemoteAttendee["responseStatus"]>,
): Array<RemoteAttendee> {
  return attendees.map((attendee) =>
    attendee.self === true ? { ...attendee, responseStatus: response } : attendee,
  );
}
