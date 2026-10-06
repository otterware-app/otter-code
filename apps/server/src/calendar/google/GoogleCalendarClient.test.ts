import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { CalendarId, type CalendarChangeStep } from "@t3tools/contracts";

import { createCalendarHistory } from "../../../../../packages/client-runtime/src/calendar/optimistic.ts";

import {
  EVENTS_PAGE_FIELDS,
  CALENDARS_PAGE_FIELDS,
  makeGoogleCalendarClient,
  parseRetryAfter,
  patchBody,
} from "./GoogleCalendarClient.ts";
import type { RemoteEvent } from "../providers/CalendarProvider.ts";

interface Seen {
  readonly method: string;
  readonly url: URL;
  readonly body: string;
  readonly authorization: string | undefined;
}

/** A client against scripted answers; `"network"` fails the request before any response. */
const harness = (
  reply: (seen: Seen, index: number) => Response | "network" | Promise<Response>,
) => {
  const requests: Seen[] = [];
  const delays: number[] = [];
  const rejected: string[] = [];
  let token = 1;
  const http = HttpClient.make((request, url) =>
    Effect.suspend(() => {
      const seen: Seen = {
        method: request.method,
        url,
        body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        authorization: request.headers.authorization,
      };
      requests.push(seen);
      const answer = reply(seen, requests.length - 1);
      return answer === "network"
        ? Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            }),
          )
        : (answer instanceof Response ? Effect.succeed(answer) : Effect.promise(() => answer)).pipe(
            Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
          );
    }),
  );
  const client = makeGoogleCalendarClient({
    http,
    accessToken: (rejectedToken) =>
      Effect.sync(() => {
        if (rejectedToken) {
          rejected.push(rejectedToken);
          token++;
        }
        return `token-${token}`;
      }),
    sleep: (millis) => Effect.sync(() => void delays.push(millis)),
  });
  return { client, requests, delays, rejected };
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const googleError = (status: number, reason: string, headers: Record<string, string> = {}) =>
  json(
    { error: { code: status, message: `Google says ${reason}`, errors: [{ reason }] } },
    status,
    headers,
  );
const event: RemoteEvent = { id: "evt1", status: "confirmed", summary: "Standup" };
const holidays = "en.german#holiday@group.v.calendar.google.com";

it.effect(
  "undo waits for Google's pending delete and restores it instead of undoing an older edit",
  () =>
    Effect.gen(function* () {
      const deletionStarted = Promise.withResolvers<void>();
      const deleteResponse = Promise.withResolvers<Response>();
      const deletionCompleted = Promise.withResolvers<void>();
      const restoreRequested = Promise.withResolvers<ReadonlyArray<CalendarChangeStep>>();
      const restoreCompleted = Promise.withResolvers<{
        readonly ok: true;
        readonly undo: CalendarChangeStep[];
      }>();
      const calendarId = CalendarId.make("calendar");
      const history = createCalendarHistory();
      history.record({
        label: "Edited event",
        steps: [{ _tag: "update", input: { calendarId, eventId: event.id, title: "Old" } }],
      });
      const { client, requests } = harness((seen) => {
        if (seen.method === "DELETE") {
          deletionStarted.resolve();
          return deleteResponse.promise;
        }
        return json(event);
      });
      const mutation = history.trackMutation(async () => {
        await deletionCompleted.promise;
        history.record({
          label: "Deleted event",
          steps: [{ _tag: "restore", input: { calendarId, eventId: event.id } }],
        });
      });
      yield* client.deleteEvent(calendarId, event.id, {}).pipe(
        Effect.tap(() => Effect.sync(() => deletionCompleted.resolve())),
        Effect.forkScoped,
      );
      yield* Effect.promise(() => deletionStarted.promise);
      let sentSteps: ReadonlyArray<CalendarChangeStep> | undefined;
      const undo = history.undo((steps) => {
        sentSteps = steps;
        restoreRequested.resolve(steps);
        return restoreCompleted.promise;
      });
      expect(sentSteps).toBeUndefined();
      deleteResponse.resolve(new Response(null, { status: 204 }));
      yield* Effect.promise(() => mutation);
      const steps = yield* Effect.promise(() => restoreRequested.promise);
      expect(steps).toEqual([{ _tag: "restore", input: { calendarId, eventId: event.id } }]);
      yield* client.patchEvent(
        calendarId,
        event.id,
        { status: "confirmed" },
        {
          current: { ...event, status: "cancelled" },
        },
      );
      restoreCompleted.resolve({
        ok: true,
        undo: [{ _tag: "delete", input: { calendarId, eventId: event.id } }],
      });
      expect((yield* Effect.promise(() => undo))._tag).toBe("done");
      expect(requests.map((request) => [request.method, request.body])).toEqual([
        ["DELETE", ""],
        ["PATCH", '{"status":"confirmed"}'],
      ]);
      expect(history.getState().undo.map((entry) => entry.label)).toEqual(["Edited event"]);
      expect(history.getState().redo.map((entry) => entry.label)).toEqual(["Deleted event"]);
    }),
);

describe("listEvents", () => {
  it.effect("asks for masters and exceptions with a fields mask, and pages to the sync token", () =>
    Effect.gen(function* () {
      const { client, requests } = harness((_, index) =>
        index === 0
          ? json({ items: [event], nextPageToken: "page-2", timeZone: "Europe/Berlin" })
          : json({ items: [], nextSyncToken: "sync-1", timeZone: "Europe/Berlin" }),
      );
      const first = yield* client.listEvents(holidays, { timeMin: "2026-01-01T00:00:00Z" });
      expect(first).toEqual({
        events: [event],
        nextPageToken: "page-2",
        timeZone: "Europe/Berlin",
      });
      const last = yield* client.listEvents(holidays, {
        timeMin: "2026-01-01T00:00:00Z",
        pageToken: "page-2",
      });
      expect(last).toEqual({ events: [], nextSyncToken: "sync-1", timeZone: "Europe/Berlin" });

      const url = requests[0]!.url;
      expect(url.origin + url.pathname).toBe(
        "https://www.googleapis.com/calendar/v3/calendars/en.german%23holiday%40group.v.calendar.google.com/events",
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        singleEvents: "false",
        showDeleted: "true",
        maxResults: "2500",
        fields: EVENTS_PAGE_FIELDS,
        timeMin: "2026-01-01T00:00:00Z",
      });
      expect(requests[1]!.url.searchParams.get("pageToken")).toBe("page-2");
      expect(requests[0]!.authorization).toBe("Bearer token-1");
    }),
  );

  it.effect("sends a sync token instead of the time bound", () =>
    Effect.gen(function* () {
      const { client, requests } = harness(() => json({ items: [], nextSyncToken: "sync-2" }));
      yield* client.listEvents("primary", { syncToken: "sync-1", timeMin: "2026-01-01T00:00:00Z" });
      const params = requests[0]!.url.searchParams;
      expect(params.get("syncToken")).toBe("sync-1");
      expect(params.has("timeMin")).toBe(false);
    }),
  );

  it("masks exactly the declared event fields plus the page tokens", () => {
    expect(EVENTS_PAGE_FIELDS.startsWith("nextPageToken,nextSyncToken,timeZone,items(id,")).toBe(
      true,
    );
    expect(EVENTS_PAGE_FIELDS).toContain(
      "attendees(email,displayName,responseStatus,optional,organizer,self,resource,comment)",
    );
    expect(CALENDARS_PAGE_FIELDS.startsWith("nextPageToken,nextSyncToken,items(id,")).toBe(true);
  });

  it.effect("reports an expired sync token as gone, without retrying", () =>
    Effect.gen(function* () {
      const { client, requests } = harness(() => googleError(410, "fullSyncRequired"));
      const error = yield* Effect.flip(client.listEvents("primary", { syncToken: "old" }));
      expect(error.reason).toBe("gone");
      expect(requests).toHaveLength(1);
    }),
  );
});

describe("errors", () => {
  it.effect.each([
    { status: 400, reason: "badRequest", expected: "invalid" },
    { status: 403, reason: "forbiddenForNonOrganizer", expected: "forbidden" },
    { status: 404, reason: "notFound", expected: "not_found" },
    { status: 409, reason: "duplicate", expected: "conflict" },
    { status: 412, reason: "conditionNotMet", expected: "conflict" },
  ])("maps $status $reason to $expected without retrying", ({ status, reason, expected }) =>
    Effect.gen(function* () {
      const { client, requests } = harness(() => googleError(status, reason));
      const error = yield* Effect.flip(client.getEvent("primary", "evt1"));
      expect(error.reason).toBe(expected);
      expect(requests).toHaveLength(1);
    }),
  );

  it.effect("backs off rate limits with full jitter, then gives up as rate limited", () =>
    Effect.gen(function* () {
      const { client, requests, delays } = harness(() => googleError(403, "rateLimitExceeded"));
      const error = yield* Effect.flip(client.getEvent("primary", "evt1"));
      expect(error.reason).toBe("rate_limited");
      expect(requests).toHaveLength(5);
      expect(delays).toHaveLength(4);
      delays.forEach((delay, index) => {
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(500 * 2 ** index);
      });
    }),
  );

  it.effect("waits as long as Retry-After says, then succeeds", () =>
    Effect.gen(function* () {
      const { client, delays } = harness((_, index) =>
        index === 0 ? googleError(429, "rateLimitExceeded", { "retry-after": "3" }) : json(event),
      );
      expect(yield* client.getEvent("primary", "evt1")).toEqual(event);
      expect(delays).toEqual([3000]);
    }),
  );

  it.effect("gives up at once when Retry-After is longer than a request should wait", () =>
    Effect.gen(function* () {
      const { client, requests } = harness(() =>
        googleError(429, "rateLimitExceeded", { "retry-after": "600" }),
      );
      expect((yield* Effect.flip(client.getEvent("primary", "evt1"))).reason).toBe("rate_limited");
      expect(requests).toHaveLength(1);
    }),
  );

  it.effect("retries server and network failures, then reports Google as unavailable", () =>
    Effect.gen(function* () {
      const flaky = harness((_, index) =>
        index === 0 ? googleError(503, "backendError") : index === 1 ? "network" : json(event),
      );
      expect(yield* flaky.client.getEvent("primary", "evt1")).toEqual(event);
      expect(flaky.delays).toHaveLength(2);

      const down = harness(() => googleError(500, "backendError"));
      expect((yield* Effect.flip(down.client.getEvent("primary", "evt1"))).reason).toBe(
        "unavailable",
      );
      expect(down.requests).toHaveLength(5);
    }),
  );

  it.effect("refreshes the token once on 401, then reports the account as signed out", () =>
    Effect.gen(function* () {
      const once = harness((seen) =>
        seen.authorization === "Bearer token-1" ? googleError(401, "authError") : json(event),
      );
      expect(yield* once.client.getEvent("primary", "evt1")).toEqual(event);
      expect(once.rejected).toEqual(["token-1"]);
      expect(once.requests.map((seen) => seen.authorization)).toEqual([
        "Bearer token-1",
        "Bearer token-2",
      ]);

      const always = harness(() => googleError(401, "authError"));
      expect((yield* Effect.flip(always.client.getEvent("primary", "evt1"))).reason).toBe(
        "signed_out",
      );
      expect(always.requests).toHaveLength(2);
    }),
  );
});

describe("writes", () => {
  it.effect("inserts and patches with conference data enabled and the chosen notifications", () =>
    Effect.gen(function* () {
      const { client, requests } = harness(() => json(event));
      yield* client.insertEvent("primary", { summary: "Standup" }, { sendUpdates: "all" });
      yield* client.patchEvent(
        "primary",
        "evt1_20261001T090000Z",
        { summary: "Moved" },
        { sendUpdates: "none", current: event },
      );
      const [insert, patch] = requests;
      expect(insert!.method).toBe("POST");
      expect(insert!.url.pathname).toBe("/calendar/v3/calendars/primary/events");
      expect(insert!.url.searchParams.get("conferenceDataVersion")).toBe("1");
      expect(insert!.url.searchParams.get("sendUpdates")).toBe("all");
      expect(insert!.body).toBe('{"summary":"Standup"}');
      expect(patch!.method).toBe("PATCH");
      expect(patch!.url.pathname).toBe(
        "/calendar/v3/calendars/primary/events/evt1_20261001T090000Z",
      );
      expect(patch!.url.searchParams.get("conferenceDataVersion")).toBe("1");
      expect(patch!.url.searchParams.get("sendUpdates")).toBe("none");
    }),
  );

  it.effect("treats deleting an already deleted event as done", () =>
    Effect.gen(function* () {
      const { client, requests } = harness((_, index) =>
        index === 0 ? new Response(null, { status: 204 }) : googleError(410, "deleted"),
      );
      yield* client.deleteEvent("primary", "evt1", { sendUpdates: "all" });
      yield* client.deleteEvent("primary", "evt1", {});
      expect(requests.map((seen) => seen.method)).toEqual(["DELETE", "DELETE"]);
      expect(requests[0]!.url.searchParams.get("sendUpdates")).toBe("all");
    }),
  );

  it.effect("moves an event to another calendar", () =>
    Effect.gen(function* () {
      const { client, requests } = harness(() => json(event));
      yield* client.moveEvent("primary", "evt1", "team@group.calendar.google.com", {
        current: event,
      });
      expect(requests[0]!.method).toBe("POST");
      expect(requests[0]!.url.pathname).toBe("/calendar/v3/calendars/primary/events/evt1/move");
      expect(requests[0]!.url.searchParams.get("destination")).toBe(
        "team@group.calendar.google.com",
      );
    }),
  );

  it.effect("keeps calendar colors and visibility local", () =>
    Effect.gen(function* () {
      const { client, requests } = harness(() => json({}));
      yield* client.patchCalendar("primary", { selected: false, backgroundColor: "#112233" });
      expect(requests).toHaveLength(0);
    }),
  );
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates", () => {
    const now = Date.UTC(2026, 8, 30, 12, 0, 0);
    expect(parseRetryAfter("7", now)).toBe(7000);
    expect(parseRetryAfter("Wed, 30 Sep 2026 12:00:10 GMT", now)).toBe(10_000);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
  });
});

describe("patchBody", () => {
  it("clears the other time form when an event switches between timed and all-day", () => {
    expect(patchBody({ start: { date: "2026-10-01" }, end: { date: "2026-10-02" } })).toEqual({
      start: { date: "2026-10-01", dateTime: null, timeZone: null },
      end: { date: "2026-10-02", dateTime: null, timeZone: null },
    });
    expect(
      patchBody({ start: { dateTime: "2026-10-01T09:00:00+02:00", timeZone: "Europe/Berlin" } }),
    ).toEqual({
      start: { dateTime: "2026-10-01T09:00:00+02:00", timeZone: "Europe/Berlin", date: null },
    });
    expect(patchBody({ summary: "Hi" })).toEqual({ summary: "Hi" });
  });
});
