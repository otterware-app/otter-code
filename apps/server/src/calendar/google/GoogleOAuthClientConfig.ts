/**
 * The environment's Google OAuth client. Resolution order: the settings (id and secret stored
 * together as one secret), then `T3CODE_GOOGLE_CLIENT_ID`/`T3CODE_GOOGLE_CLIENT_SECRET`, then
 * the values baked into the build from the repository's `.env`.
 *
 * It must be a Google "Desktop app" client. Google's installed-app docs treat its secret as
 * not confidential, which is why builds may embed it; the settings let users bring their own.
 *
 * @module GoogleOAuthClientConfig
 */
import { CalendarError, type GoogleClientInput, type GoogleClientSource } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import type { GoogleClientStatus } from "./GoogleAuth.ts";

declare const __T3CODE_BUILD_GOOGLE_CLIENT_ID__: string | undefined;
declare const __T3CODE_BUILD_GOOGLE_CLIENT_SECRET__: string | undefined;

export const GOOGLE_OAUTH_CLIENT_SECRET_NAME = "calendar-google-oauth-client";

export interface GoogleOAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly source: GoogleClientSource;
}

export interface GoogleOAuthClientValues {
  readonly clientId: string;
  readonly clientSecret: string;
}

const buildTimeClient: GoogleOAuthClientValues = {
  clientId:
    typeof __T3CODE_BUILD_GOOGLE_CLIENT_ID__ === "undefined"
      ? ""
      : __T3CODE_BUILD_GOOGLE_CLIENT_ID__,
  clientSecret:
    typeof __T3CODE_BUILD_GOOGLE_CLIENT_SECRET__ === "undefined"
      ? ""
      : __T3CODE_BUILD_GOOGLE_CLIENT_SECRET__,
};

const EnvironmentClient = Config.all({
  clientId: Config.String("T3CODE_GOOGLE_CLIENT_ID").pipe(Config.withDefault("")),
  clientSecret: Config.String("T3CODE_GOOGLE_CLIENT_SECRET").pipe(Config.withDefault("")),
});

const StoredClient = Schema.fromJsonString(
  Schema.Struct({ clientId: Schema.String, clientSecret: Schema.String }),
);
const decodeStoredClient = Schema.decodeUnknownEffect(StoredClient);
const encodeStoredClient = Schema.encodeEffect(StoredClient);

const GOOGLE_CLIENT_ID = /^[\w.-]{1,256}\.apps\.googleusercontent\.com$/u;

const resolved = (
  source: GoogleClientSource,
  values: GoogleOAuthClientValues,
): Option.Option<GoogleOAuthClient> => {
  const clientId = values.clientId.trim();
  const clientSecret = values.clientSecret.trim();
  return clientId && clientSecret ? Option.some({ clientId, clientSecret, source }) : Option.none();
};

const toClientStatus = (client: Option.Option<GoogleOAuthClient>): GoogleClientStatus =>
  Option.match(client, {
    onNone: () => ({ configured: false, source: null, clientId: null }),
    onSome: ({ clientId, source }) => ({ configured: true, source, clientId }),
  });

const failed = (detail: string) => () => new CalendarError({ code: "failed", detail });

/** @param build the build-time values; tests pass their own. */
export const make = Effect.fn("GoogleOAuthClientConfig.make")(function* (
  build: GoogleOAuthClientValues = buildTimeClient,
) {
  const secrets = yield* ServerSecretStore;
  const environment = yield* EnvironmentClient.pipe(
    Effect.orElseSucceed(() => ({ clientId: "", clientSecret: "" })),
  );
  const fallback = Option.orElse(resolved("environment", environment), () =>
    resolved("build", build),
  );

  const stored = yield* secrets.get(GOOGLE_OAUTH_CLIENT_SECRET_NAME).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<GoogleOAuthClient>()),
        onSome: (bytes) =>
          decodeStoredClient(new TextDecoder().decode(bytes)).pipe(
            Effect.map((values) => resolved("settings", values)),
          ),
      }),
    ),
    Effect.catch(() =>
      Effect.logWarning("Ignoring the unreadable Google OAuth client from the settings.").pipe(
        Effect.as(Option.none<GoogleOAuthClient>()),
      ),
    ),
  );
  const settings = yield* Ref.make(stored);
  const changes = yield* PubSub.unbounded<GoogleClientStatus>();
  const writes = yield* Semaphore.make(1);

  const current = Ref.get(settings).pipe(Effect.map(Option.orElse(() => fallback)));
  const publish = current.pipe(
    Effect.flatMap((client) => PubSub.publish(changes, toClientStatus(client))),
  );

  const set = (input: GoogleClientInput) =>
    Effect.gen(function* () {
      const clientId = input.clientId.trim();
      const clientSecret = input.clientSecret.trim();
      if (!GOOGLE_CLIENT_ID.test(clientId))
        return yield* new CalendarError({
          code: "invalid",
          detail:
            "That is not a Google OAuth client id. It ends in .apps.googleusercontent.com and belongs to a Desktop app client.",
        });
      const json = yield* encodeStoredClient({ clientId, clientSecret }).pipe(
        Effect.mapError(failed("Could not save the Google OAuth client.")),
      );
      yield* secrets
        .set(GOOGLE_OAUTH_CLIENT_SECRET_NAME, new TextEncoder().encode(json))
        .pipe(Effect.mapError(failed("Could not save the Google OAuth client.")));
      yield* Ref.set(settings, Option.some({ clientId, clientSecret, source: "settings" }));
      yield* publish;
    }).pipe(writes.withPermits(1));

  const clear = Effect.gen(function* () {
    yield* secrets
      .remove(GOOGLE_OAUTH_CLIENT_SECRET_NAME)
      .pipe(Effect.mapError(failed("Could not remove the Google OAuth client.")));
    yield* Ref.set(settings, Option.none());
    yield* publish;
  }).pipe(writes.withPermits(1));

  return {
    /** The client new sign-ins and token refreshes use. */
    current,
    status: Effect.map(current, toClientStatus),
    set,
    clear,
    changes: Stream.fromPubSub(changes),
  };
});

export type GoogleOAuthClientConfig = Effect.Success<ReturnType<typeof make>>;
