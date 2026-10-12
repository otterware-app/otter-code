/**
 * A `GoogleAuth` for builds without Google sign-in: no OAuth client is configured and connecting
 * fails with `not_configured`. Demo accounts work as usual. `server.ts` wires the live layer
 * (`google/GoogleAuthLive.ts`) once it exists; tests use this or their own fake.
 *
 * @module GoogleAuthUnavailable
 */
import { CalendarError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { GoogleAuth, type GoogleClientStatus } from "./google/GoogleAuth.ts";
import {
  CalendarProviderError,
  type CalendarProviderClient,
} from "./providers/CalendarProvider.ts";

const notConfigured = () =>
  new CalendarError({
    code: "not_configured",
    detail: "Google sign-in is not available in this build.",
  });

const signedOut = () =>
  Effect.fail(
    new CalendarProviderError({
      reason: "signed_out",
      detail: "Google sign-in is not available in this build.",
    }),
  );

const unavailableClient: CalendarProviderClient = {
  listCalendars: signedOut,
  listEvents: signedOut,
  getEvent: signedOut,
  insertEvent: signedOut,
  patchEvent: signedOut,
  deleteEvent: signedOut,
  moveEvent: signedOut,
  patchCalendar: signedOut,
};

const status: GoogleClientStatus = { configured: false, source: null, clientId: null };

export const layer = Layer.succeed(
  GoogleAuth,
  GoogleAuth.of({
    clientStatus: Effect.succeed(status),
    setClient: () => Effect.fail(notConfigured()),
    clearClient: Effect.void,
    clientChanges: Stream.empty,
    connect: () => Stream.fail(notConfigured()),
    completeConnect: () => Effect.fail(notConfigured()),
    client: () => unavailableClient,
    hasTokens: () => Effect.succeed(false),
    removeTokens: () => Effect.void,
  }),
);
