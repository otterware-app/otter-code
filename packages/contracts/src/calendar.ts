/**
 * Otter Calendar's domain: Google accounts (or demo accounts), their calendars, and the events
 * the environment syncs into SQLite. Clients never talk to Google; they subscribe to the
 * directory (accounts, calendars, preferences) and to week-sized chunks of event instances,
 * and change events through the RPC methods below. The agent's calendar tools call the same
 * service.
 *
 * Times on the wire:
 * - Instances (`CalendarEventInstance`) carry `start`/`end` as epoch milliseconds. For timed
 *   events they are instants. For all-day events they are the dates at UTC midnight (end
 *   exclusive), i.e. floating dates, so a 2026-10-01 all-day event is `Date.UTC(2026, 9, 1)`
 *   to `Date.UTC(2026, 9, 2)` in every time zone.
 * - Inputs (`CalendarEventTimeInput`) use strings: ISO 8601 instants with an offset or `Z` for
 *   timed events, `YYYY-MM-DD` dates (end exclusive) for all-day events.
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, makeEntityId } from "./suite/calendarVendor/baseSchemas.ts";

// ── Identity ─────────────────────────────────────────────────────────

export const CalendarAccountId = makeEntityId("CalendarAccountId");
export type CalendarAccountId = typeof CalendarAccountId.Type;

/** The environment's own short id for a calendar (not Google's calendar id). */
export const CalendarId = makeEntityId("CalendarId");
export type CalendarId = typeof CalendarId.Type;

/**
 * Google's event id within a calendar. A recurring event's instances have ids of the form
 * `<seriesId>_<originalStart>` (for example `abc123_20261001T090000Z`), like Google's.
 */
export const CalendarEventId = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));
export type CalendarEventId = typeof CalendarEventId.Type;

/** `<calendarId>/<eventId>`: unique across the environment. */
export function calendarEventKey(calendarId: string, eventId: string): string {
  return `${calendarId}/${eventId}`;
}

/** Epoch milliseconds. */
export const EpochMillis = Schema.Number;

/** `YYYY-MM-DD`. */
export const CalendarDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
export type CalendarDate = typeof CalendarDate.Type;

/** An IANA time zone name such as `Europe/Berlin`. */
export const TimeZoneName = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/** `#rrggbb`. */
export const HexColor = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));

// ── Directory: accounts, calendars, preferences ──────────────────────

export const CalendarProviderKind = Schema.Literals(["google", "demo"]);
export type CalendarProviderKind = typeof CalendarProviderKind.Type;

export const CalendarAccountStatus = Schema.Literals([
  /** Synced and syncing normally. */
  "ok",
  /** First sync still running. */
  "syncing",
  /** The last sync failed; `error` says why. Retries continue with backoff. */
  "error",
  /** Google revoked the sign-in or it expired: only signing in again helps. */
  "signed_out",
]);
export type CalendarAccountStatus = typeof CalendarAccountStatus.Type;

export const CalendarAccount = Schema.Struct({
  accountId: CalendarAccountId,
  provider: CalendarProviderKind,
  email: Schema.String,
  displayName: Schema.String,
  avatarUrl: Schema.optional(Schema.String),
  status: CalendarAccountStatus,
  error: Schema.optional(Schema.String),
  lastSyncedAt: Schema.optional(EpochMillis),
  /** Order in the sidebar. */
  position: Schema.Number,
});
export type CalendarAccount = typeof CalendarAccount.Type;

export const CalendarAccessRole = Schema.Literals(["owner", "writer", "reader", "freeBusyReader"]);
export type CalendarAccessRole = typeof CalendarAccessRole.Type;

export const Calendar = Schema.Struct({
  calendarId: CalendarId,
  accountId: CalendarAccountId,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  color: HexColor,
  accessRole: CalendarAccessRole,
  /** The account's main calendar (Google's `primary`). */
  primary: Schema.Boolean,
  /** Shown in the combined view. Hidden calendars are not sent in week chunks. */
  visible: Schema.Boolean,
  timeZone: Schema.optional(TimeZoneName),
});
export type Calendar = typeof Calendar.Type;

export const CalendarWeekday = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }));

export const CalendarPreferences = Schema.Struct({
  /** 0 = Sunday, 1 = Monday, 6 = Saturday. */
  weekStartsOn: CalendarWeekday,
  /** The zone the calendar is shown in; null follows each device's zone. */
  timeZone: Schema.NullOr(TimeZoneName),
  /** Working hours as minutes after midnight, and the working weekdays (0 = Sunday). */
  workingHours: Schema.Struct({
    start: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1440 })),
    end: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1440 })),
    days: Schema.Array(CalendarWeekday),
  }),
  defaultEventMinutes: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 1440 })),
  /** How many days the custom multi-day view shows. */
  customDays: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 14 })),
  showWeekends: Schema.Boolean,
  showDeclined: Schema.Boolean,
  hourFormat: Schema.Literals(["locale", "12", "24"]),
  /** Where new events go; null uses the first account's primary calendar. */
  defaultCalendarId: Schema.NullOr(CalendarId),
});
export type CalendarPreferences = typeof CalendarPreferences.Type;

export const DEFAULT_CALENDAR_PREFERENCES: CalendarPreferences = {
  weekStartsOn: 1,
  timeZone: null,
  workingHours: { start: 9 * 60, end: 17 * 60, days: [1, 2, 3, 4, 5] },
  defaultEventMinutes: 30,
  customDays: 4,
  showWeekends: true,
  showDeclined: true,
  hourFormat: "locale",
  defaultCalendarId: null,
};

export const CalendarPreferencesPatch = Schema.Struct({
  weekStartsOn: Schema.optional(CalendarWeekday),
  timeZone: Schema.optional(Schema.NullOr(TimeZoneName)),
  workingHours: Schema.optional(CalendarPreferences.fields.workingHours),
  defaultEventMinutes: Schema.optional(CalendarPreferences.fields.defaultEventMinutes),
  customDays: Schema.optional(CalendarPreferences.fields.customDays),
  showWeekends: Schema.optional(Schema.Boolean),
  showDeclined: Schema.optional(Schema.Boolean),
  hourFormat: Schema.optional(CalendarPreferences.fields.hourFormat),
  defaultCalendarId: Schema.optional(Schema.NullOr(CalendarId)),
});
export type CalendarPreferencesPatch = typeof CalendarPreferencesPatch.Type;

/** Where the environment's Google OAuth client comes from; null when none is configured. */
export const GoogleClientSource = Schema.Literals(["settings", "environment", "build"]);
export type GoogleClientSource = typeof GoogleClientSource.Type;

export const CalendarDirectory = Schema.Struct({
  accounts: Schema.Array(CalendarAccount),
  calendars: Schema.Array(Calendar),
  preferences: CalendarPreferences,
  google: Schema.Struct({
    /** Whether Google accounts can be connected (an OAuth client is configured). */
    configured: Schema.Boolean,
    source: Schema.NullOr(GoogleClientSource),
    /** The configured client id, for display; never the secret. */
    clientId: Schema.NullOr(Schema.String),
  }),
});
export type CalendarDirectory = typeof CalendarDirectory.Type;

// ── Event instances (what views render) ──────────────────────────────

export const CalendarResponseStatus = Schema.Literals([
  "needsAction",
  "declined",
  "tentative",
  "accepted",
]);
export type CalendarResponseStatus = typeof CalendarResponseStatus.Type;

/**
 * One occurrence on the calendar: a single event, or one instance of a recurring series.
 * Deliberately small; `calendar.getEvent` returns the rest.
 */
export const CalendarEventInstance = Schema.Struct({
  calendarId: CalendarId,
  eventId: CalendarEventId,
  /** The recurring series this instance belongs to. */
  seriesId: Schema.optional(CalendarEventId),
  title: Schema.String,
  start: EpochMillis,
  end: EpochMillis,
  allDay: Schema.optional(Schema.Boolean),
  /** Only when tentative; confirmed is the default and cancelled instances are never sent. */
  tentative: Schema.optional(Schema.Boolean),
  /** The user's own RSVP when they are an attendee but not the organizer. */
  response: Schema.optional(CalendarResponseStatus),
  /** The event's own color when it overrides its calendar's. */
  color: Schema.optional(HexColor),
  /** Shortened to fit an event block. */
  location: Schema.optional(Schema.String),
  /** Marked as free (Google's `transparency: transparent`). */
  free: Schema.optional(Schema.Boolean),
  /** Has a video call link. */
  meet: Schema.optional(Schema.Boolean),
  /** Whether the user may move, resize or edit it here. */
  readOnly: Schema.optional(Schema.Boolean),
});
export type CalendarEventInstance = typeof CalendarEventInstance.Type;

/**
 * Week chunks are the unit clients subscribe to: 7 UTC days starting on a Monday at 00:00 UTC.
 * A view subscribes to every chunk overlapping its dates (padded by a day on each side, so a
 * view in any zone is covered) and merges them by `calendarEventKey`. Chunks keep the payload
 * to what a view shows and let clients cache and prefetch neighbouring weeks.
 */
export const CalendarWeekInput = Schema.Struct({
  /** The chunk's Monday, `YYYY-MM-DD`. */
  week: CalendarDate,
});
export type CalendarWeekInput = typeof CalendarWeekInput.Type;

export const CalendarWeekEvent = Schema.Union([
  /** Every visible instance overlapping the week. Always first. */
  Schema.TaggedStruct("snapshot", { instances: Schema.Array(CalendarEventInstance) }),
  /** Added or changed instances overlapping the week. */
  Schema.TaggedStruct("upserted", { instances: Schema.Array(CalendarEventInstance) }),
  /** Instances that left the week, by `calendarEventKey`. */
  Schema.TaggedStruct("removed", { keys: Schema.Array(Schema.String) }),
  /**
   * Replaces all of one calendar's instances in the week: after a full resync, a large
   * change, or a visibility change (an empty list when the calendar was hidden or removed).
   */
  Schema.TaggedStruct("calendarReplaced", {
    calendarId: CalendarId,
    instances: Schema.Array(CalendarEventInstance),
  }),
]);
export type CalendarWeekEvent = typeof CalendarWeekEvent.Type;

// ── Event details ────────────────────────────────────────────────────

export const CalendarAttendee = Schema.Struct({
  email: Schema.String,
  displayName: Schema.optional(Schema.String),
  responseStatus: CalendarResponseStatus,
  optional: Schema.optional(Schema.Boolean),
  organizer: Schema.optional(Schema.Boolean),
  /** The user (the account this calendar belongs to). */
  self: Schema.optional(Schema.Boolean),
  /** A room or other resource. */
  resource: Schema.optional(Schema.Boolean),
});
export type CalendarAttendee = typeof CalendarAttendee.Type;

export const CalendarConference = Schema.Struct({
  /** Where to join, e.g. `https://meet.google.com/abc-defg-hij`. */
  url: Schema.String,
  /** e.g. `Google Meet`. */
  name: Schema.String,
  /** Dial-in or meeting code details, when Google provides them. */
  details: Schema.optional(Schema.String),
});
export type CalendarConference = typeof CalendarConference.Type;

export const CalendarEventDetails = Schema.Struct({
  ...CalendarEventInstance.fields,
  description: Schema.String,
  /** The whole location (instances carry a shortened one). */
  location: Schema.optional(Schema.String),
  /** The zone the event was created in, e.g. for "10:00 in Berlin". */
  timeZone: Schema.optional(TimeZoneName),
  /** The series' RRULE/EXDATE/RDATE lines, for instances and masters of recurring events. */
  recurrence: Schema.optional(Schema.Array(Schema.String)),
  /** For instances: the start the series originally scheduled, as epoch ms. */
  originalStart: Schema.optional(EpochMillis),
  organizer: Schema.optional(
    Schema.Struct({
      email: Schema.String,
      displayName: Schema.optional(Schema.String),
      self: Schema.optional(Schema.Boolean),
    }),
  ),
  attendees: Schema.Array(CalendarAttendee),
  conference: Schema.optional(CalendarConference),
  /** Link to the event on calendar.google.com (Google accounts only). */
  htmlLink: Schema.optional(Schema.String),
  /** Whether the user can RSVP (they are a non-organizer attendee). */
  canRespond: Schema.Boolean,
  visibility: Schema.optional(Schema.Literals(["default", "public", "private", "confidential"])),
  createdAt: Schema.optional(EpochMillis),
  updatedAt: Schema.optional(EpochMillis),
});
export type CalendarEventDetails = typeof CalendarEventDetails.Type;

export const CalendarEventRefInput = Schema.Struct({
  calendarId: CalendarId,
  eventId: CalendarEventId,
});
export type CalendarEventRefInput = typeof CalendarEventRefInput.Type;

// ── Changing events ──────────────────────────────────────────────────

/** Which occurrences of a recurring event a change applies to. Ignored for single events. */
export const CalendarChangeScope = Schema.Literals(["this", "following", "all"]);
export type CalendarChangeScope = typeof CalendarChangeScope.Type;

export const CalendarSendUpdates = Schema.Literals(["all", "externalOnly", "none"]);
export type CalendarSendUpdates = typeof CalendarSendUpdates.Type;

export const CalendarEventTimeInput = Schema.Struct({
  allDay: Schema.Boolean,
  /** ISO instant with offset or `Z` for timed events; `YYYY-MM-DD` for all-day events. */
  start: TrimmedNonEmptyString,
  /** Exclusive. ISO instant for timed events; `YYYY-MM-DD` for all-day events. */
  end: TrimmedNonEmptyString,
  /** The event's zone; defaults to the calendar's, then the preferences', then the server's. */
  timeZone: Schema.optional(TimeZoneName),
});
export type CalendarEventTimeInput = typeof CalendarEventTimeInput.Type;

const EventFields = {
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(8192))),
  location: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  /** Guest emails. Replaces the whole list; the organizer stays. */
  attendees: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(320))).check(
      Schema.isMaxLength(200),
    ),
  ),
  /** RRULE/EXDATE/RDATE lines (`RRULE:FREQ=WEEKLY;BYDAY=MO`); an empty list stops repeating. */
  recurrence: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(1024))).check(Schema.isMaxLength(20)),
  ),
  /** Adds a Google Meet link (Google accounts) or a placeholder link (demo accounts). */
  addConference: Schema.optional(Schema.Boolean),
  /** Show as free instead of busy. */
  free: Schema.optional(Schema.Boolean),
  visibility: Schema.optional(Schema.Literals(["default", "public", "private"])),
  sendUpdates: Schema.optional(CalendarSendUpdates),
};

export const CalendarCreateEventInput = Schema.Struct({
  calendarId: CalendarId,
  time: CalendarEventTimeInput,
  ...EventFields,
});
export type CalendarCreateEventInput = typeof CalendarCreateEventInput.Type;

export const CalendarUpdateEventInput = Schema.Struct({
  calendarId: CalendarId,
  eventId: CalendarEventId,
  /** Defaults to `this`. */
  scope: Schema.optional(CalendarChangeScope),
  time: Schema.optional(CalendarEventTimeInput),
  /** Moves the event to another calendar (of the same account for Google). */
  targetCalendarId: Schema.optional(CalendarId),
  ...EventFields,
});
export type CalendarUpdateEventInput = typeof CalendarUpdateEventInput.Type;

export const CalendarDeleteEventInput = Schema.Struct({
  calendarId: CalendarId,
  eventId: CalendarEventId,
  scope: Schema.optional(CalendarChangeScope),
  sendUpdates: Schema.optional(CalendarSendUpdates),
});
export type CalendarDeleteEventInput = typeof CalendarDeleteEventInput.Type;

export const CalendarRespondInput = Schema.Struct({
  calendarId: CalendarId,
  eventId: CalendarEventId,
  /** `needsAction` withdraws an answer (the undo of a first RSVP). */
  response: CalendarResponseStatus,
  /** `this` answers for one occurrence, `all` for the whole series. */
  scope: Schema.optional(Schema.Literals(["this", "all"])),
});
export type CalendarRespondInput = typeof CalendarRespondInput.Type;

/** Brings back a deleted event or occurrence (undo of a delete). */
export const CalendarRestoreEventInput = CalendarEventRefInput;
export type CalendarRestoreEventInput = typeof CalendarRestoreEventInput.Type;

/**
 * One step that reverts part of a change. Every mutation answers with the steps that undo it,
 * computed by the server from the state before the change; clients keep them on an undo stack
 * and send them back through `calendar.applyChanges`, which answers with the redo steps.
 */
export const CalendarChangeStep = Schema.Union([
  Schema.TaggedStruct("create", { input: CalendarCreateEventInput }),
  Schema.TaggedStruct("update", { input: CalendarUpdateEventInput }),
  Schema.TaggedStruct("delete", { input: CalendarDeleteEventInput }),
  Schema.TaggedStruct("restore", { input: CalendarRestoreEventInput }),
  Schema.TaggedStruct("respond", { input: CalendarRespondInput }),
]);
export type CalendarChangeStep = typeof CalendarChangeStep.Type;

export const CalendarMutationResult = Schema.Struct({
  /** The event as it is now; absent after a delete. */
  event: Schema.optional(CalendarEventDetails),
  /** Steps that revert this change, in order. */
  undo: Schema.Array(CalendarChangeStep),
});
export type CalendarMutationResult = typeof CalendarMutationResult.Type;

export const CalendarApplyChangesInput = Schema.Struct({
  steps: Schema.Array(CalendarChangeStep).check(Schema.isMaxLength(20)),
});
export type CalendarApplyChangesInput = typeof CalendarApplyChangesInput.Type;

// ── Search ───────────────────────────────────────────────────────────

export const CalendarSearchInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type CalendarSearchInput = typeof CalendarSearchInput.Type;

export const CalendarSearchResult = Schema.Struct({
  results: Schema.Array(CalendarEventInstance),
});
export type CalendarSearchResult = typeof CalendarSearchResult.Type;

// ── Accounts ─────────────────────────────────────────────────────────

export const CalendarAccountRefInput = Schema.Struct({ accountId: CalendarAccountId });
export type CalendarAccountRefInput = typeof CalendarAccountRefInput.Type;

export const CalendarSyncInput = Schema.Struct({
  /** Omit to sync every account. */
  accountId: Schema.optional(CalendarAccountId),
});
export type CalendarSyncInput = typeof CalendarSyncInput.Type;

export const CalendarDemoSize = Schema.Literals(["standard", "massive"]);
export type CalendarDemoSize = typeof CalendarDemoSize.Type;

export const CalendarAddDemoInput = Schema.Struct({
  /** `standard`: three accounts, a few months of realistic data. `massive`: the performance set. */
  size: CalendarDemoSize,
  seed: Schema.optional(Schema.Int),
});
export type CalendarAddDemoInput = typeof CalendarAddDemoInput.Type;

export const CalendarUpdateCalendarInput = Schema.Struct({
  calendarId: CalendarId,
  visible: Schema.optional(Schema.Boolean),
  color: Schema.optional(HexColor),
});
export type CalendarUpdateCalendarInput = typeof CalendarUpdateCalendarInput.Type;

/**
 * Connecting a Google account. The environment runs the OAuth flow (PKCE, loopback redirect to
 * `http://127.0.0.1:<port>/`) and listens on that port itself, which completes the flow when
 * the browser runs on the environment's machine. When it runs elsewhere (remote web, mobile),
 * the client carries the redirect URL back with `calendar.google.connectComplete`: the desktop
 * app catches it on its own loopback port, other clients ask the user to paste it.
 */
export const GoogleConnectInput = Schema.Struct({
  /** Preselects the Google account, e.g. when signing an account back in. */
  loginHint: Schema.optional(Schema.String.check(Schema.isMaxLength(320))),
});
export type GoogleConnectInput = typeof GoogleConnectInput.Type;

export const GoogleConnectState = Schema.Union([
  /** Open `authorizationUrl` in a browser; the flow waits for Google's redirect. */
  Schema.TaggedStruct("waiting", {
    flowId: TrimmedNonEmptyString,
    authorizationUrl: Schema.String,
    redirectUri: Schema.String,
  }),
  /** The code arrived; the environment is exchanging it and loading the account. */
  Schema.TaggedStruct("exchanging", {}),
  Schema.TaggedStruct("succeeded", { accountId: CalendarAccountId, email: Schema.String }),
  Schema.TaggedStruct("failed", { message: Schema.String }),
]);
export type GoogleConnectState = typeof GoogleConnectState.Type;

export const GoogleConnectCompleteInput = Schema.Struct({
  flowId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  callbackUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
});
export type GoogleConnectCompleteInput = typeof GoogleConnectCompleteInput.Type;

export const GoogleClientInput = Schema.Struct({
  clientId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  clientSecret: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type GoogleClientInput = typeof GoogleClientInput.Type;

// ── Errors ───────────────────────────────────────────────────────────

export class CalendarError extends Schema.TaggedError<CalendarError>()("CalendarError", {
  code: Schema.Literals([
    "not_found",
    "read_only",
    "invalid",
    "conflict",
    "signed_out",
    "rate_limited",
    "not_configured",
    "unavailable",
    "failed",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
