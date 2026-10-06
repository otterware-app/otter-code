/**
 * GoogleAuth - Google sign-in for calendar accounts, owned by the environment.
 *
 * The OAuth client (a Google "Desktop app" client) comes from, in order: the calendar settings
 * (client id and secret stored together in the server's secret store), the
 * `T3CODE_GOOGLE_CLIENT_ID`/`T3CODE_GOOGLE_CLIENT_SECRET` environment variables, or values baked
 * into the build from the repository's `.env`. Tokens are stored per account in the secret
 * store; access tokens live in memory and are refreshed shortly before they expire.
 *
 * Sign-in is the installed-app flow with PKCE and a loopback redirect: the environment listens
 * on `http://127.0.0.1:<port>` itself, and also accepts the redirect URL from a client (the desktop
 * app catching it on its own loopback port, or the user pasting it) for browsers on another
 * machine. See `docs/internals/calendar-engine.md`.
 *
 * @module GoogleAuth
 */
import type {
  CalendarError,
  GoogleClientInput,
  GoogleClientSource,
  GoogleConnectCompleteInput,
  GoogleConnectInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { CalendarProviderClient } from "../providers/CalendarProvider.ts";

/** Who signed in, from Google's userinfo endpoint. */
export interface GoogleIdentity {
  /** Google's stable account id (`sub`); the key tokens are stored under. */
  readonly sub: string;
  readonly email: string;
  readonly name?: string;
  readonly picture?: string;
}

export type GoogleConnectFlowEvent =
  | {
      readonly _tag: "waiting";
      readonly flowId: string;
      readonly authorizationUrl: string;
      readonly redirectUri: string;
    }
  | { readonly _tag: "exchanging" }
  /** Tokens are stored under `identity.sub`; the stream ends after this. */
  | { readonly _tag: "connected"; readonly identity: GoogleIdentity }
  | { readonly _tag: "failed"; readonly message: string };

export interface GoogleClientStatus {
  readonly configured: boolean;
  readonly source: GoogleClientSource | null;
  readonly clientId: string | null;
}

export interface GoogleAuthShape {
  readonly clientStatus: Effect.Effect<GoogleClientStatus>;
  /** Stores a client from the settings (secret in the secret store). */
  readonly setClient: (input: GoogleClientInput) => Effect.Effect<void, CalendarError>;
  readonly clearClient: Effect.Effect<void, CalendarError>;
  /** Changes of `clientStatus`, for the directory stream. */
  readonly clientChanges: Stream.Stream<GoogleClientStatus>;
  /**
   * Runs one sign-in: `waiting` (open the URL), `exchanging`, then `connected` or `failed`.
   * Ending the stream early cancels the flow and closes its loopback listener.
   */
  readonly connect: (
    input: GoogleConnectInput,
  ) => Stream.Stream<GoogleConnectFlowEvent, CalendarError>;
  /** Completes a waiting flow with the redirect URL a client caught or the user pasted. */
  readonly completeConnect: (
    input: GoogleConnectCompleteInput,
  ) => Effect.Effect<void, CalendarError>;
  /** An API client for a signed-in account, refreshing its access token as needed. */
  readonly client: (sub: string) => CalendarProviderClient;
  readonly hasTokens: (sub: string) => Effect.Effect<boolean>;
  /** Forgets the account's tokens (and revokes them with Google, best effort). */
  readonly removeTokens: (sub: string) => Effect.Effect<void>;
}

export class GoogleAuth extends Context.Service<GoogleAuth, GoogleAuthShape>()(
  "t3/calendar/google/GoogleAuth",
) {}
