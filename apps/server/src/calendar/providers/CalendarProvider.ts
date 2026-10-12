/**
 * The seam between the calendar service (which owns SQLite, materialized instances and the
 * sync loop) and where calendar data comes from: Google Calendar, or the demo source that
 * fakes it. Both speak Google Calendar API v3 shapes, so the demo source exercises exactly the
 * code paths a real account does.
 *
 * A client is bound to one account. Implementations handle their own authentication (token
 * refresh), retries of transient failures (rate limits with backoff, 5xx) and paging limits;
 * they report everything else as a `CalendarProviderError`.
 *
 * @module CalendarProvider
 */
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";

// ── Google Calendar API v3 shapes (the subset the app reads and writes) ──

/** `calendarList` entry. */
export interface RemoteCalendar {
  readonly id: string;
  readonly summary?: string;
  /** The user's own name for a calendar they subscribed to. */
  readonly summaryOverride?: string;
  readonly description?: string;
  readonly backgroundColor?: string;
  readonly foregroundColor?: string;
  readonly colorId?: string;
  readonly accessRole?: "owner" | "writer" | "reader" | "freeBusyReader";
  readonly primary?: boolean;
  /** Google's "show in list" checkbox. */
  readonly selected?: boolean;
  readonly hidden?: boolean;
  readonly timeZone?: string;
  /** Present in incremental calendar-list syncs for removed entries. */
  readonly deleted?: boolean;
}

/** `start`, `end`, `originalStartTime`: `date` (all-day) or `dateTime` (+ optional zone). */
export interface RemoteEventDateTime {
  readonly date?: string;
  readonly dateTime?: string;
  readonly timeZone?: string;
}

export interface RemoteAttendee {
  readonly email: string;
  readonly displayName?: string;
  readonly responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  readonly optional?: boolean;
  readonly organizer?: boolean;
  readonly self?: boolean;
  readonly resource?: boolean;
  readonly comment?: string;
}

export interface RemoteConferenceData {
  readonly conferenceId?: string;
  readonly conferenceSolution?: {
    readonly name?: string;
    readonly key?: { readonly type?: string };
  };
  readonly entryPoints?: ReadonlyArray<{
    readonly entryPointType?: "video" | "phone" | "sip" | "more";
    readonly uri?: string;
    readonly label?: string;
    readonly pin?: string;
    readonly meetingCode?: string;
  }>;
  readonly createRequest?: {
    readonly requestId: string;
    readonly conferenceSolutionKey?: { readonly type: string };
    readonly status?: { readonly statusCode?: string };
  };
}

/** `events` resource. Cancelled events and cancelled instances carry little besides ids. */
export interface RemoteEvent {
  readonly id: string;
  readonly status?: "confirmed" | "tentative" | "cancelled";
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly colorId?: string;
  readonly start?: RemoteEventDateTime;
  readonly end?: RemoteEventDateTime;
  /** Only on recurring masters: RRULE, EXRULE, RDATE and EXDATE lines. */
  readonly recurrence?: ReadonlyArray<string>;
  /** On instances and exceptions: the master's id. */
  readonly recurringEventId?: string;
  /** On instances and exceptions: when the series scheduled this occurrence. */
  readonly originalStartTime?: RemoteEventDateTime;
  readonly transparency?: "opaque" | "transparent";
  readonly visibility?: "default" | "public" | "private" | "confidential";
  readonly attendees?: ReadonlyArray<RemoteAttendee>;
  readonly attendeesOmitted?: boolean;
  readonly organizer?: {
    readonly email?: string;
    readonly displayName?: string;
    readonly self?: boolean;
  };
  readonly creator?: {
    readonly email?: string;
    readonly displayName?: string;
    readonly self?: boolean;
  };
  readonly guestsCanModify?: boolean;
  readonly conferenceData?: RemoteConferenceData;
  readonly hangoutLink?: string;
  readonly htmlLink?: string;
  readonly iCalUID?: string;
  readonly sequence?: number;
  readonly created?: string;
  readonly updated?: string;
  readonly etag?: string;
  readonly eventType?: string;
  readonly locked?: boolean;
  readonly privateCopy?: boolean;
}

/** A write: any subset of the event, as `events.insert`/`events.patch` accept it. */
export type RemoteEventWrite = { -readonly [K in keyof RemoteEvent]?: RemoteEvent[K] };

export interface RemoteEventsPage {
  readonly events: ReadonlyArray<RemoteEvent>;
  /** More pages follow; pass it back as `pageToken`. */
  readonly nextPageToken?: string;
  /** On the last page: the token for the next incremental sync. */
  readonly nextSyncToken?: string;
  /** The calendar's zone, as `events.list` reports it. */
  readonly timeZone?: string;
}

export interface RemoteCalendarsPage {
  readonly calendars: ReadonlyArray<RemoteCalendar>;
  readonly nextPageToken?: string;
  readonly nextSyncToken?: string;
}

export interface ListEventsOptions {
  /** Incremental sync; mutually exclusive with `timeMin`. */
  readonly syncToken?: string;
  readonly pageToken?: string;
  /** Full sync lower bound (RFC 3339). */
  readonly timeMin?: string;
}

export interface WriteOptions {
  readonly sendUpdates?: "all" | "externalOnly" | "none";
}

// ── Errors ───────────────────────────────────────────────────────────

export class CalendarProviderError extends Schema.TaggedError<CalendarProviderError>()(
  "CalendarProviderError",
  {
    reason: Schema.Literals([
      /** 410: the sync token expired; drop it and run a full sync. */
      "gone",
      /** Still rate limited after the client's own retries. */
      "rate_limited",
      /** The sign-in was revoked or expired (`invalid_grant`); only signing in again helps. */
      "signed_out",
      "not_found",
      /** 403 other than rate limits: no permission for this change. */
      "forbidden",
      /** 400: the request was rejected as invalid. */
      "invalid",
      /** 409/412: the event changed or already exists. */
      "conflict",
      /** Network failure or 5xx after retries. */
      "unavailable",
      "failed",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

// ── The client ───────────────────────────────────────────────────────

export interface CalendarProviderClient {
  /** One page of the account's calendar list (`calendarList.list`, `showDeleted` with a sync token). */
  readonly listCalendars: (options: {
    readonly syncToken?: string;
    readonly pageToken?: string;
  }) => Effect.Effect<RemoteCalendarsPage, CalendarProviderError>;
  /**
   * One page of a calendar's events (`events.list` with `singleEvents=false`,
   * `showDeleted=true`, `maxResults=2500`): singles, recurring masters, and exceptions.
   */
  readonly listEvents: (
    calendarRemoteId: string,
    options: ListEventsOptions,
  ) => Effect.Effect<RemoteEventsPage, CalendarProviderError>;
  readonly getEvent: (
    calendarRemoteId: string,
    eventId: string,
  ) => Effect.Effect<RemoteEvent, CalendarProviderError>;
  /** `events.insert` (with `conferenceDataVersion=1` when a conference is requested). */
  readonly insertEvent: (
    calendarRemoteId: string,
    event: RemoteEventWrite,
    options: WriteOptions,
  ) => Effect.Effect<RemoteEvent, CalendarProviderError>;
  /**
   * `events.patch`. `current` is the stored event (for an instance id not stored yet, the
   * occurrence as the service materialized it), which the demo source patches locally.
   */
  readonly patchEvent: (
    calendarRemoteId: string,
    eventId: string,
    patch: RemoteEventWrite,
    options: WriteOptions & { readonly current: RemoteEvent },
  ) => Effect.Effect<RemoteEvent, CalendarProviderError>;
  /** `events.delete`. Deleting an instance id cancels that one occurrence. */
  readonly deleteEvent: (
    calendarRemoteId: string,
    eventId: string,
    options: WriteOptions,
  ) => Effect.Effect<void, CalendarProviderError>;
  /** `events.move`: changes the organizer calendar; answers with the moved event. */
  readonly moveEvent: (
    calendarRemoteId: string,
    eventId: string,
    destinationRemoteId: string,
    options: WriteOptions & { readonly current: RemoteEvent },
  ) => Effect.Effect<RemoteEvent, CalendarProviderError>;
  /** `calendarList.patch` for the user's own settings of a calendar (color, selected). */
  readonly patchCalendar: (
    calendarRemoteId: string,
    patch: {
      readonly selected?: boolean;
      readonly backgroundColor?: string;
      readonly foregroundColor?: string;
    },
  ) => Effect.Effect<void, CalendarProviderError>;
}
