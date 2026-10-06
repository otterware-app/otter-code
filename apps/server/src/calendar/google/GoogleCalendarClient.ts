/**
 * The Google Calendar API v3 client behind `CalendarProviderClient`: one account, its access
 * token supplied by `GoogleAuth`. Requests ask for exactly the fields the app reads (partial
 * responses keep sync pages small), retry rate limits and transient failures with capped
 * exponential backoff and full jitter, and map everything else to `CalendarProviderError`.
 *
 * @module GoogleCalendarClient
 */
import { BRAND } from "@t3tools/shared/brand";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import {
  CalendarProviderError,
  type CalendarProviderClient,
  type RemoteCalendar,
  type RemoteCalendarsPage,
  type RemoteEvent,
  type RemoteEventsPage,
  type RemoteEventWrite,
  type WriteOptions,
} from "../providers/CalendarProvider.ts";

const API = "https://www.googleapis.com/calendar/v3";
const REQUEST_TIMEOUT = "30 seconds";
/** Attempts per request for rate limits, 5xx and network failures. */
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 32_000;
/** A longer `Retry-After` is not waited out inside one request; the caller's sync backs off. */
const RETRY_AFTER_CAP_MS = 60_000;
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]);

// ── Partial responses ────────────────────────────────────────────────
// Typed against the Remote* interfaces, so a field added there must be added here too.

const EVENT_FIELDS = Object.values({
  id: "id",
  status: "status",
  summary: "summary",
  description: "description",
  location: "location",
  colorId: "colorId",
  start: "start",
  end: "end",
  recurrence: "recurrence",
  recurringEventId: "recurringEventId",
  originalStartTime: "originalStartTime",
  transparency: "transparency",
  visibility: "visibility",
  attendees: "attendees(email,displayName,responseStatus,optional,organizer,self,resource,comment)",
  attendeesOmitted: "attendeesOmitted",
  organizer: "organizer(email,displayName,self)",
  creator: "creator(email,displayName,self)",
  guestsCanModify: "guestsCanModify",
  conferenceData:
    "conferenceData(conferenceId,conferenceSolution(name,key/type),entryPoints(entryPointType,uri,label,pin,meetingCode),createRequest(requestId,conferenceSolutionKey/type,status/statusCode))",
  hangoutLink: "hangoutLink",
  htmlLink: "htmlLink",
  iCalUID: "iCalUID",
  sequence: "sequence",
  created: "created",
  updated: "updated",
  etag: "etag",
  eventType: "eventType",
  locked: "locked",
  privateCopy: "privateCopy",
} satisfies Record<keyof RemoteEvent, string>).join(",");

const CALENDAR_FIELDS = Object.values({
  id: "id",
  summary: "summary",
  summaryOverride: "summaryOverride",
  description: "description",
  backgroundColor: "backgroundColor",
  foregroundColor: "foregroundColor",
  colorId: "colorId",
  accessRole: "accessRole",
  primary: "primary",
  selected: "selected",
  hidden: "hidden",
  timeZone: "timeZone",
  deleted: "deleted",
} satisfies Record<keyof RemoteCalendar, string>).join(",");

/** The page tokens must be in the mask: leaving `nextSyncToken` out silently drops it. */
export const EVENTS_PAGE_FIELDS = `nextPageToken,nextSyncToken,timeZone,items(${EVENT_FIELDS})`;
export const CALENDARS_PAGE_FIELDS = `nextPageToken,nextSyncToken,items(${CALENDAR_FIELDS})`;
const SINGLE_EVENT_FIELDS = EVENT_FIELDS;

// ── Responses ────────────────────────────────────────────────────────

const ErrorBody = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      message: Schema.optional(Schema.String),
      errors: Schema.optional(
        Schema.Array(Schema.Struct({ reason: Schema.optional(Schema.String) })),
      ),
    }),
  }),
);
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

type Json = { readonly [key: string]: unknown };

const hasId = (value: unknown): boolean =>
  Predicate.isObject(value) && Predicate.isString(value.id);
const optionalString = (body: Json, key: string) =>
  Predicate.isString(body[key]) ? { [key]: body[key] } : {};

const providerError = (reason: CalendarProviderError["reason"], detail: string) =>
  new CalendarProviderError({ reason, detail });

const unexpected = () =>
  providerError("failed", "Google Calendar answered with something the app does not understand.");

const asObject = (body: unknown) =>
  Predicate.isObject(body) ? Effect.succeed<Json>(body) : Effect.fail(unexpected());

const asEvent = (body: unknown) =>
  hasId(body) ? Effect.succeed(body as unknown as RemoteEvent) : Effect.fail(unexpected());

const asItems = <A>(body: Json): Effect.Effect<ReadonlyArray<A>, CalendarProviderError> => {
  const items = body.items ?? [];
  return Array.isArray(items) && items.every(hasId)
    ? Effect.succeed(items as ReadonlyArray<A>)
    : Effect.fail(unexpected());
};

/** Seconds or an HTTP date, as milliseconds from `now`. */
/**
 * `events.patch` merges nested objects, so switching an event between timed and all-day must
 * clear the other form explicitly: `{ date }` alone would keep the old `dateTime`.
 */
export function patchBody(patch: RemoteEventWrite): Record<string, unknown> {
  const body: Record<string, unknown> = { ...patch };
  for (const key of ["start", "end"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    body[key] =
      value.date !== undefined
        ? { ...value, dateTime: null, timeZone: null }
        : value.dateTime !== undefined
          ? { ...value, date: null }
          : value;
  }
  return body;
}

export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

const withMessage = (message: string | undefined, fallback: string) => {
  const text = message?.trim();
  return text ? `${fallback}: ${text.length > 300 ? `${text.slice(0, 300)}...` : text}` : fallback;
};

/** Maps a final (non-retried) error answer. */
function statusError(status: number, reasons: ReadonlyArray<string>, message?: string) {
  switch (status) {
    case 400:
      return providerError("invalid", withMessage(message, "Google Calendar rejected the request"));
    case 401:
      return providerError(
        "signed_out",
        "Google no longer accepts the sign-in for this account. Sign in again.",
      );
    case 403:
      return reasons.some((reason) => RATE_LIMIT_REASONS.has(reason))
        ? providerError(
            "rate_limited",
            "Google Calendar is limiting requests for this account. Try again in a minute.",
          )
        : providerError("forbidden", withMessage(message, "Google Calendar refused this change"));
    case 404:
      return providerError("not_found", "Google Calendar could not find this calendar or event.");
    case 409:
    case 412:
      return providerError(
        "conflict",
        withMessage(message, "The event changed on Google Calendar"),
      );
    case 410:
      return providerError("gone", "The sync position expired; a full sync is needed.");
    case 429:
      return providerError(
        "rate_limited",
        "Google Calendar is limiting requests for this account. Try again in a minute.",
      );
    default:
      return status >= 500
        ? providerError("unavailable", "Google Calendar is not available right now.")
        : providerError("failed", withMessage(message, `Google Calendar answered ${status}`));
  }
}

const retryable = (status: number, reasons: ReadonlyArray<string>) =>
  status === 429 ||
  status >= 500 ||
  (status === 403 && reasons.some((reason) => RATE_LIMIT_REASONS.has(reason)));

export interface GoogleCalendarClientOptions {
  readonly http: HttpClient.HttpClient;
  /**
   * A valid access token for the account. `rejected` is a token Google just answered 401 to:
   * the next token must be a fresh one.
   */
  readonly accessToken: (rejected?: string) => Effect.Effect<string, CalendarProviderError>;
  /** Waits between retries; tests record the delays instead of waiting. */
  readonly sleep?: (millis: number) => Effect.Effect<void>;
}

export function makeGoogleCalendarClient(
  options: GoogleCalendarClientOptions,
): CalendarProviderClient {
  const sleep = options.sleep ?? ((millis: number) => Effect.sleep(millis));
  const backoff = (attempt: number) =>
    Random.next.pipe(
      Effect.map((random) =>
        Math.floor(random * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1))),
      ),
    );

  /**
   * Sends one API request with retries. A 401 refreshes the token once, without using up an
   * attempt. Answers the parsed JSON body, or `undefined` for an empty one.
   */
  const send = Effect.fnUntraced(function* (
    build: () => HttpClientRequest.HttpClientRequest,
    okStatuses: ReadonlyArray<number> = [],
  ) {
    let rejected: string | undefined;
    let refreshed = false;
    let attempt = 1;
    while (true) {
      const token = yield* options.accessToken(rejected).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason === "unavailable" && attempt < MAX_ATTEMPTS,
          () => Effect.succeedNone,
        ),
      );
      if (Option.isNone(token)) {
        yield* sleep(yield* backoff(attempt++));
        continue;
      }
      rejected = undefined;
      const reply = yield* options.http
        .execute(
          build().pipe(
            HttpClientRequest.bearerToken(token.value),
            HttpClientRequest.acceptJson,
            HttpClientRequest.setHeader("user-agent", `${BRAND.displayName} (gzip)`),
          ),
        )
        .pipe(
          Effect.flatMap((response) =>
            response.text.pipe(
              Effect.map((text) => ({ status: response.status, headers: response.headers, text })),
            ),
          ),
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.option,
        );
      if (Option.isNone(reply)) {
        if (attempt < MAX_ATTEMPTS) {
          yield* sleep(yield* backoff(attempt++));
          continue;
        }
        return yield* providerError("unavailable", "Could not reach Google Calendar.");
      }
      const { status, headers, text } = reply.value;
      if ((status >= 200 && status < 300) || okStatuses.includes(status)) {
        if (!text.trim() || okStatuses.includes(status)) return undefined;
        return yield* decodeJson(text).pipe(Effect.mapError(unexpected));
      }
      if (status === 401 && !refreshed) {
        refreshed = true;
        rejected = token.value;
        continue;
      }
      const body = decodeErrorBody(text);
      const reasons = Option.match(body, {
        onNone: () => [],
        onSome: ({ error }) =>
          (error.errors ?? []).flatMap(({ reason }) => (reason ? [reason] : [])),
      });
      if (retryable(status, reasons) && attempt < MAX_ATTEMPTS) {
        const retryAfter = parseRetryAfter(
          Option.getOrUndefined(Headers.get(headers, "retry-after")),
          yield* Clock.currentTimeMillis,
        );
        if (retryAfter === undefined || retryAfter <= RETRY_AFTER_CAP_MS) {
          yield* sleep(retryAfter ?? (yield* backoff(attempt)));
          attempt++;
          continue;
        }
      }
      return yield* statusError(
        status,
        reasons,
        Option.getOrUndefined(Option.flatMapNullishOr(body, ({ error }) => error.message)),
      );
    }
  });

  const calendarPath = (calendarId: string) => `${API}/calendars/${encodeURIComponent(calendarId)}`;
  const eventPath = (calendarId: string, eventId: string) =>
    `${calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`;
  const updates = (options: WriteOptions) =>
    options.sendUpdates ? { sendUpdates: options.sendUpdates } : {};

  return {
    listCalendars: ({ syncToken, pageToken }) =>
      send(() =>
        HttpClientRequest.get(`${API}/users/me/calendarList`).pipe(
          // Incremental syncs always include deleted and hidden entries, and every request of
          // a sync must use the same parameters, so the full sync asks for them too.
          HttpClientRequest.setUrlParams({
            maxResults: 250,
            showDeleted: true,
            showHidden: true,
            fields: CALENDARS_PAGE_FIELDS,
            ...(syncToken ? { syncToken } : {}),
            ...(pageToken ? { pageToken } : {}),
          }),
        ),
      ).pipe(
        Effect.flatMap(asObject),
        Effect.flatMap((body): Effect.Effect<RemoteCalendarsPage, CalendarProviderError> =>
          asItems<RemoteCalendar>(body).pipe(
            Effect.map((calendars) => ({
              calendars,
              ...optionalString(body, "nextPageToken"),
              ...optionalString(body, "nextSyncToken"),
            })),
          ),
        ),
        Effect.withSpan("GoogleCalendarClient.listCalendars"),
      ),

    listEvents: (calendarId, { syncToken, pageToken, timeMin }) =>
      send(() =>
        HttpClientRequest.get(`${calendarPath(calendarId)}/events`).pipe(
          HttpClientRequest.setUrlParams({
            singleEvents: false,
            showDeleted: true,
            maxResults: 2500,
            fields: EVENTS_PAGE_FIELDS,
            // `timeMin` cannot be combined with a sync token.
            ...(syncToken ? { syncToken } : timeMin ? { timeMin } : {}),
            ...(pageToken ? { pageToken } : {}),
          }),
        ),
      ).pipe(
        Effect.flatMap(asObject),
        Effect.flatMap((body): Effect.Effect<RemoteEventsPage, CalendarProviderError> =>
          asItems<RemoteEvent>(body).pipe(
            Effect.map((events) => ({
              events,
              ...optionalString(body, "nextPageToken"),
              ...optionalString(body, "nextSyncToken"),
              ...optionalString(body, "timeZone"),
            })),
          ),
        ),
        Effect.withSpan("GoogleCalendarClient.listEvents"),
      ),

    getEvent: (calendarId, eventId) =>
      send(() =>
        HttpClientRequest.get(eventPath(calendarId, eventId)).pipe(
          HttpClientRequest.setUrlParams({ fields: SINGLE_EVENT_FIELDS }),
        ),
      ).pipe(Effect.flatMap(asEvent), Effect.withSpan("GoogleCalendarClient.getEvent")),

    // `conferenceDataVersion=1` on every write: without it Google drops conference changes.
    insertEvent: (calendarId, event, options) =>
      send(() =>
        HttpClientRequest.post(`${calendarPath(calendarId)}/events`).pipe(
          HttpClientRequest.setUrlParams({
            conferenceDataVersion: 1,
            fields: SINGLE_EVENT_FIELDS,
            ...updates(options),
          }),
          HttpClientRequest.bodyJsonUnsafe(event),
        ),
      ).pipe(Effect.flatMap(asEvent), Effect.withSpan("GoogleCalendarClient.insertEvent")),

    patchEvent: (calendarId, eventId, patch, options) =>
      send(() =>
        HttpClientRequest.patch(eventPath(calendarId, eventId)).pipe(
          HttpClientRequest.setUrlParams({
            conferenceDataVersion: 1,
            fields: SINGLE_EVENT_FIELDS,
            ...updates(options),
          }),
          HttpClientRequest.bodyJsonUnsafe(patchBody(patch)),
        ),
      ).pipe(Effect.flatMap(asEvent), Effect.withSpan("GoogleCalendarClient.patchEvent")),

    // 410 means the event is already deleted, which is what the caller wanted.
    deleteEvent: (calendarId, eventId, options) =>
      send(
        () =>
          HttpClientRequest.delete(eventPath(calendarId, eventId)).pipe(
            HttpClientRequest.setUrlParams(updates(options)),
          ),
        [410],
      ).pipe(Effect.asVoid, Effect.withSpan("GoogleCalendarClient.deleteEvent")),

    moveEvent: (calendarId, eventId, destinationId, options) =>
      send(() =>
        HttpClientRequest.post(`${eventPath(calendarId, eventId)}/move`).pipe(
          HttpClientRequest.setUrlParams({
            destination: destinationId,
            fields: SINGLE_EVENT_FIELDS,
            ...updates(options),
          }),
        ),
      ).pipe(Effect.flatMap(asEvent), Effect.withSpan("GoogleCalendarClient.moveEvent")),

    // Calendar colors and visibility stay local to the app, so nothing is written to Google and
    // the sign-in does not need calendar-list write access.
    patchCalendar: () => Effect.void,
  };
}
