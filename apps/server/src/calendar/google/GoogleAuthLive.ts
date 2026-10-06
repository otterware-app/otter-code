// @effect-diagnostics nodeBuiltinImport:off - The loopback listener and PKCE use Node's http and crypto.
/**
 * GoogleAuthLive - Google sign-in, tokens and API clients for calendar accounts.
 *
 * Sign-in is the installed-app flow with PKCE: every flow listens on its own OS-assigned port on
 * `127.0.0.1` and also accepts the redirect URL from a client (`completeConnect`) when the
 * browser runs on another machine. Both paths go through the same checks in
 * `@t3tools/shared/googleAuthCallback`.
 *
 * Tokens are stored per account (`calendar-google-token-<sub>`) with the client id that issued
 * them. Access tokens are cached in memory and refreshed two minutes before they expire; callers
 * of the same account share one refresh.
 *
 * Codes, tokens and secrets are never logged.
 *
 * @module GoogleAuthLive
 */
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import { CalendarError } from "@t3tools/contracts";
import {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  googleCallbackUrl,
  googleLoopbackRedirectUri,
  handleGoogleCallbackRequest,
} from "@t3tools/shared/googleAuthCallback";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { CalendarProviderError } from "../providers/CalendarProvider.ts";
import {
  GoogleAuth,
  type GoogleAuthShape,
  type GoogleConnectFlowEvent,
  type GoogleIdentity,
} from "./GoogleAuth.ts";
import { makeGoogleCalendarClient } from "./GoogleCalendarClient.ts";
import * as GoogleOAuthClientConfig from "./GoogleOAuthClientConfig.ts";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const CALENDAR_LIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
/**
 * `calendar.events` covers reading and writing events (including instances and moves) and
 * `calendar.calendarlist.readonly` the calendar list. Calendar colors and visibility stay local,
 * so the broad `calendar` scope ("see, edit, share, and permanently delete all the calendars")
 * is not needed. Both are sensitive, not restricted, scopes. Installed apps get no incremental
 * authorization, so every scope is requested up front.
 */
export const GOOGLE_SCOPES = ["openid", "email", "profile", EVENTS_SCOPE, CALENDAR_LIST_SCOPE];
const REQUIRED_SCOPES = [EVENTS_SCOPE, CALENDAR_LIST_SCOPE];

const FLOW_TIMEOUT = "5 minutes";
const TOKEN_REQUEST_TIMEOUT = "30 seconds";
const REFRESH_MARGIN_MS = 2 * 60_000;
/** Google's `sub` is a numeric string; anything else must not become a secret file name. */
const SUBJECT = /^[\w-]{1,255}$/u;

export const tokenSecretName = (sub: string) => `calendar-google-token-${sub}`;

// ── Wire and storage shapes ──────────────────────────────────────────

const StoredTokens = Schema.Struct({
  /** The OAuth client that issued the tokens; Google refreshes them only for that client. */
  clientId: Schema.String,
  refreshToken: Schema.String,
  accessToken: Schema.String,
  /** Epoch milliseconds. */
  expiresAt: Schema.Number,
  scopes: Schema.Array(Schema.String),
});
type StoredTokens = typeof StoredTokens.Type;
const StoredTokensJson = Schema.fromJsonString(StoredTokens);
const decodeStoredTokens = Schema.decodeUnknownEffect(StoredTokensJson);
const encodeStoredTokens = Schema.encodeEffect(StoredTokensJson);

const TokenResponse = Schema.fromJsonString(
  Schema.Struct({
    access_token: Schema.String,
    expires_in: Schema.Number,
    refresh_token: Schema.optional(Schema.String),
    scope: Schema.optional(Schema.String),
  }),
);
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);
const OAuthErrorResponse = Schema.fromJsonString(Schema.Struct({ error: Schema.String }));
const decodeOAuthError = Schema.decodeUnknownOption(OAuthErrorResponse);
const UserInfo = Schema.fromJsonString(
  Schema.Struct({
    sub: Schema.String,
    email: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    picture: Schema.optional(Schema.String),
  }),
);
const decodeUserInfo = Schema.decodeUnknownEffect(UserInfo);

/** A failed token endpoint call: an OAuth error code, `unavailable`, or `invalid_response`. */
class TokenEndpointError extends Schema.TaggedError<TokenEndpointError>()(
  "GoogleTokenEndpointError",
  { error: Schema.String },
) {}

/** Ends a sign-in with a message for the user. */
class FlowFailure extends Schema.TaggedError<FlowFailure>()("GoogleFlowFailure", {
  message: Schema.String,
}) {}

const randomToken = (bytes: number) => NodeCrypto.randomBytes(bytes).toString("base64url");
const scopesOf = (scope: string | undefined) => (scope ?? "").split(/\s+/u).filter(Boolean);

/** Users paste what the address bar shows, which may lack the scheme. */
const normalizePastedUrl = (value: string) => {
  const trimmed = value.trim();
  return /^[a-z][\w+.-]*:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
};

const exchangeMessage = (error: string) => {
  switch (error) {
    case "invalid_grant":
      return "This sign-in expired or was already used. Start again.";
    case "invalid_client":
    case "unauthorized_client":
      return "Google rejected this environment's OAuth client. Check the client id and secret in Settings.";
    case "unavailable":
      return "Could not reach Google. Check the connection and try again.";
    default:
      return "Google could not complete the sign-in. Try again.";
  }
};

/** Why a refresh failed, as the sync loop should treat it. */
const refreshError = (error: string) => {
  switch (error) {
    // The user revoked access, the token went unused for six months, the account minted more
    // than 100 refresh tokens for this client, or the client is in "Testing" publishing status,
    // where Google expires refresh tokens after seven days. Only a new sign-in helps.
    case "invalid_grant":
      return new CalendarProviderError({
        reason: "signed_out",
        detail: "Google ended the sign-in for this account. Sign in again.",
      });
    case "invalid_client":
    case "unauthorized_client":
      return new CalendarProviderError({
        reason: "failed",
        detail:
          "Google rejected this environment's OAuth client. Check the client id and secret in Settings.",
      });
    case "unavailable":
      return new CalendarProviderError({
        reason: "unavailable",
        detail: "Could not reach Google to renew the sign-in.",
      });
    default:
      return new CalendarProviderError({
        reason: "failed",
        detail: "Google could not renew the sign-in for this account.",
      });
  }
};

interface PendingFlow {
  readonly redirectUri: string;
  readonly state: string;
  readonly callback: Deferred.Deferred<URL>;
}

interface CachedAccessToken {
  readonly clientId: string;
  readonly accessToken: string;
  readonly expiresAt: number;
}

/** @param build the build-time OAuth client; tests pass their own. */
export const make = Effect.fn("GoogleAuthLive.make")(function* (
  build?: GoogleOAuthClientConfig.GoogleOAuthClientValues,
) {
  const secrets = yield* ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const scope = yield* Scope.Scope;
  const clients = yield* GoogleOAuthClientConfig.make(build);

  const flows = new Map<string, PendingFlow>();
  const cache = new Map<string, CachedAccessToken>();
  const locks = new Map<string, Semaphore.Semaphore>();
  /** Serializes token reads and writes per account, so concurrent callers share one refresh. */
  const withAccountLock = (sub: string) => {
    let lock = locks.get(sub);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(sub, lock);
    }
    return lock.withPermits(1);
  };

  const readTokens = (sub: string) =>
    (SUBJECT.test(sub) ? secrets.get(tokenSecretName(sub)) : Effect.succeedNone).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (bytes) =>
            decodeStoredTokens(new TextDecoder().decode(bytes)).pipe(Effect.asSome),
        }),
      ),
    );
  const writeTokens = (sub: string, tokens: StoredTokens) =>
    encodeStoredTokens(tokens).pipe(
      Effect.flatMap((json) => secrets.set(tokenSecretName(sub), new TextEncoder().encode(json))),
    );

  const tokenRequest = Effect.fnUntraced(function* (body: Record<string, string>) {
    const reply = yield* http
      .execute(
        HttpClientRequest.post(TOKEN_ENDPOINT).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyUrlParams(body),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
        ),
        Effect.timeout(TOKEN_REQUEST_TIMEOUT),
        Effect.mapError(() => new TokenEndpointError({ error: "unavailable" })),
      );
    if (reply.status >= 200 && reply.status < 300)
      return yield* decodeTokenResponse(reply.text).pipe(
        Effect.mapError(() => new TokenEndpointError({ error: "invalid_response" })),
      );
    if (reply.status >= 500) return yield* new TokenEndpointError({ error: "unavailable" });
    return yield* new TokenEndpointError({
      error: Option.match(decodeOAuthError(reply.text), {
        onNone: () => "invalid_response",
        onSome: ({ error }) => error,
      }),
    });
  });

  /**
   * Revokes a grant, best effort. Google revokes every token of the account for the whole
   * OAuth project, so this only runs when an account is removed, never when it is replaced.
   */
  const revoke = (token: string) =>
    http
      .execute(
        HttpClientRequest.post(REVOKE_ENDPOINT).pipe(HttpClientRequest.bodyUrlParams({ token })),
      )
      .pipe(Effect.timeout(TOKEN_REQUEST_TIMEOUT), Effect.ignore);

  // ── Access tokens ──────────────────────────────────────────────────

  const accessToken = (sub: string, rejected?: string) =>
    Effect.gen(function* () {
      const client = yield* clients.current;
      if (Option.isNone(client))
        return yield* new CalendarProviderError({
          reason: "failed",
          detail:
            "Google sign-in is not set up on this environment. Add an OAuth client in Settings.",
        });
      const { clientId, clientSecret } = client.value;
      const cached = (now: number) => {
        const entry = cache.get(sub);
        return entry &&
          entry.clientId === clientId &&
          entry.accessToken !== rejected &&
          entry.expiresAt - REFRESH_MARGIN_MS > now
          ? entry.accessToken
          : undefined;
      };
      const hit = cached(yield* Clock.currentTimeMillis);
      if (hit) return hit;
      return yield* withAccountLock(sub)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          // Another caller may have refreshed while this one waited for the lock.
          const refreshed = cached(now);
          if (refreshed) return refreshed;
          const stored = yield* readTokens(sub).pipe(
            Effect.mapError(
              () =>
                new CalendarProviderError({
                  reason: "failed",
                  detail: "Could not read the saved Google sign-in.",
                }),
            ),
          );
          if (Option.isNone(stored))
            return yield* new CalendarProviderError({
              reason: "signed_out",
              detail: "This Google account is not signed in on this environment. Sign in again.",
            });
          const tokens = stored.value;
          if (tokens.clientId !== clientId)
            return yield* new CalendarProviderError({
              reason: "signed_out",
              detail:
                "This account was signed in with a different Google OAuth client. Sign in again.",
            });
          if (tokens.accessToken !== rejected && tokens.expiresAt - REFRESH_MARGIN_MS > now) {
            cache.set(sub, {
              clientId,
              accessToken: tokens.accessToken,
              expiresAt: tokens.expiresAt,
            });
            return tokens.accessToken;
          }
          // A failed refresh keeps the stored tokens, so signing the same account in again
          // replaces them.
          const response = yield* tokenRequest({
            grant_type: "refresh_token",
            refresh_token: tokens.refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
          }).pipe(Effect.mapError(({ error }) => refreshError(error)));
          const next: StoredTokens = {
            ...tokens,
            accessToken: response.access_token,
            expiresAt: (yield* Clock.currentTimeMillis) + response.expires_in * 1000,
            refreshToken: response.refresh_token ?? tokens.refreshToken,
            scopes: response.scope ? scopesOf(response.scope) : tokens.scopes,
          };
          yield* writeTokens(sub, next).pipe(
            Effect.catch(() =>
              Effect.logWarning("Could not save the renewed Google access token."),
            ),
          );
          cache.set(sub, { clientId, accessToken: next.accessToken, expiresAt: next.expiresAt });
          return next.accessToken;
        }),
      );
    });

  // ── Sign-in ────────────────────────────────────────────────────────

  /** Listens on an OS-assigned loopback port until the scope closes. */
  const listen = (state: string, callback: Deferred.Deferred<URL>) =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          new Promise<NodeHttp.Server>((resolve, reject) => {
            const server = NodeHttp.createServer();
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => resolve(server));
          }),
        catch: () =>
          new FlowFailure({ message: "Could not start the local sign-in listener. Try again." }),
      }),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
    ).pipe(
      Effect.flatMap((server) => {
        const address = server.address();
        if (!address || typeof address === "string")
          return Effect.fail(
            new FlowFailure({ message: "Could not start the local sign-in listener. Try again." }),
          );
        const redirectUri = googleLoopbackRedirectUri(address.port);
        server.on("request", (request, response) => {
          if (Deferred.isDoneUnsafe(callback)) {
            response.writeHead(410).end("This sign-in is no longer active.");
            return;
          }
          const url = handleGoogleCallbackRequest(request, response, redirectUri, state);
          if (url) Deferred.doneUnsafe(callback, Effect.succeed(url));
        });
        return Effect.succeed(redirectUri);
      }),
    );

  /** Exchanges the code, loads the identity and stores the tokens. */
  const finish = Effect.fnUntraced(function* (
    client: GoogleOAuthClientConfig.GoogleOAuthClient,
    code: string,
    verifier: string,
    redirectUri: string,
  ) {
    const tokens = yield* tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }).pipe(Effect.mapError(({ error }) => new FlowFailure({ message: exchangeMessage(error) })));
    // Not revoked on failure below: revoking would also end an earlier sign-in of this account.
    if (!tokens.refresh_token)
      return yield* new FlowFailure({
        message: "Google did not grant lasting access. Try again.",
      });
    const scopes = scopesOf(tokens.scope);
    if (!REQUIRED_SCOPES.every((required) => scopes.includes(required)))
      return yield* new FlowFailure({
        message:
          "Otter Calendar needs access to your events and calendar list. Connect again and keep both calendar permissions checked.",
      });
    const info = yield* http
      .execute(
        HttpClientRequest.get(USERINFO_ENDPOINT).pipe(
          HttpClientRequest.bearerToken(tokens.access_token),
          HttpClientRequest.acceptJson,
        ),
      )
      .pipe(
        Effect.filterOrFail(
          (response) => response.status === 200,
          () => new FlowFailure({ message: "Google did not share the account's details." }),
        ),
        Effect.flatMap((response) => response.text),
        Effect.flatMap(decodeUserInfo),
        Effect.timeout(TOKEN_REQUEST_TIMEOUT),
        Effect.mapError(
          () => new FlowFailure({ message: "Google did not share the account's details." }),
        ),
      );
    if (!SUBJECT.test(info.sub) || !info.email)
      return yield* new FlowFailure({
        message: "Google did not share the account's email address. Try again.",
      });
    const identity: GoogleIdentity = {
      sub: info.sub,
      email: info.email,
      ...(info.name ? { name: info.name } : {}),
      ...(info.picture ? { picture: info.picture } : {}),
    };
    const stored: StoredTokens = {
      clientId: client.clientId,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresAt: (yield* Clock.currentTimeMillis) + tokens.expires_in * 1000,
      scopes,
    };
    yield* withAccountLock(identity.sub)(
      writeTokens(identity.sub, stored).pipe(
        Effect.tap(() =>
          Effect.sync(() =>
            cache.set(identity.sub, {
              clientId: stored.clientId,
              accessToken: stored.accessToken,
              expiresAt: stored.expiresAt,
            }),
          ),
        ),
      ),
    ).pipe(
      Effect.mapError(() => new FlowFailure({ message: "Could not save the Google sign-in." })),
    );
    return identity;
  });

  const runFlow = Effect.fnUntraced(function* (
    client: GoogleOAuthClientConfig.GoogleOAuthClient,
    loginHint: string | undefined,
    emit: (event: GoogleConnectFlowEvent) => Effect.Effect<unknown>,
  ) {
    const flowId = randomToken(16);
    const state = randomToken(32);
    const verifier = randomToken(32);
    const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");

    // The listener and the flow's registration last until the redirect arrives (or the flow
    // times out or is cancelled), not through the token exchange.
    const waited = yield* Effect.scoped(
      Effect.gen(function* () {
        const callback = yield* Deferred.make<URL>();
        const redirectUri = yield* listen(state, callback);
        yield* Effect.acquireRelease(
          Effect.sync(() => flows.set(flowId, { redirectUri, state, callback })),
          () => Effect.sync(() => flows.delete(flowId)),
        );
        const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
        authorizationUrl.search = new URLSearchParams({
          client_id: client.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: GOOGLE_SCOPES.join(" "),
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
          // Always ask which account and for consent: adding a second account needs the
          // chooser, and consent guarantees a refresh token.
          access_type: "offline",
          prompt: "select_account consent",
          ...(loginHint ? { login_hint: loginHint } : {}),
        }).toString();
        yield* emit({
          _tag: "waiting",
          flowId,
          authorizationUrl: authorizationUrl.toString(),
          redirectUri,
        });
        const received = yield* Deferred.await(callback).pipe(Effect.timeoutOption(FLOW_TIMEOUT));
        return Option.map(received, (url) => ({ url, redirectUri }));
      }),
    );
    if (Option.isNone(waited))
      return yield* new FlowFailure({ message: "Google sign-in timed out. Start again." });
    const { url, redirectUri } = waited.value;
    const error = url.searchParams.get("error");
    if (error)
      return yield* new FlowFailure({
        message:
          error === "access_denied"
            ? "Google sign-in was cancelled."
            : `Google did not complete the sign-in (${error.replace(/[^\w.-]/gu, "").slice(0, 64)}).`,
      });
    yield* emit({ _tag: "exchanging" });
    const identity = yield* finish(
      client,
      url.searchParams.get("code") ?? "",
      verifier,
      redirectUri,
    );
    yield* emit({ _tag: "connected", identity });
  });

  const connect: GoogleAuthShape["connect"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const client = yield* clients.current;
        if (Option.isNone(client))
          return yield* new CalendarError({
            code: "not_configured",
            detail: "Google sign-in is not set up. Add an OAuth client in Settings.",
          });
        return Stream.callback<GoogleConnectFlowEvent>((queue) =>
          runFlow(client.value, input.loginHint, (event) => Queue.offer(queue, event)).pipe(
            Effect.catchTag("GoogleFlowFailure", ({ message }) =>
              Queue.offer(queue, { _tag: "failed", message }),
            ),
            Effect.catchDefect((defect) =>
              Effect.logError("Google sign-in failed unexpectedly.", defect).pipe(
                Effect.andThen(
                  Queue.offer(queue, {
                    _tag: "failed",
                    message: "Google sign-in failed. Try again.",
                  }),
                ),
              ),
            ),
            Effect.andThen(Queue.end(queue)),
          ),
        );
      }),
    );

  const completeConnect: GoogleAuthShape["completeConnect"] = (input) =>
    Effect.gen(function* () {
      const flow = flows.get(input.flowId);
      if (!flow)
        return yield* new CalendarError({
          code: "not_found",
          detail: "This Google sign-in is no longer waiting. Start again.",
        });
      const url = yield* Effect.try({
        try: () =>
          googleCallbackUrl(normalizePastedUrl(input.callbackUrl), flow.redirectUri, flow.state),
        catch: () =>
          new CalendarError({
            code: "invalid",
            detail:
              "This address does not belong to the current Google sign-in. Copy the whole address from the browser's address bar.",
          }),
      });
      yield* Deferred.succeed(flow.callback, url);
    });

  // ── Accounts ───────────────────────────────────────────────────────

  const hasTokens: GoogleAuthShape["hasTokens"] = (sub) =>
    Effect.gen(function* () {
      const client = yield* clients.current;
      const stored = yield* readTokens(sub).pipe(Effect.orElseSucceed(() => Option.none()));
      return (
        Option.isSome(client) &&
        Option.isSome(stored) &&
        stored.value.clientId === client.value.clientId
      );
    });

  const removeTokens: GoogleAuthShape["removeTokens"] = (sub) =>
    Effect.gen(function* () {
      const stored = yield* withAccountLock(sub)(
        Effect.gen(function* () {
          const stored = yield* readTokens(sub).pipe(Effect.orElseSucceed(() => Option.none()));
          if (SUBJECT.test(sub))
            yield* secrets
              .remove(tokenSecretName(sub))
              .pipe(Effect.catch(() => Effect.logWarning("Could not delete a Google sign-in.")));
          cache.delete(sub);
          return stored;
        }),
      );
      if (Option.isSome(stored))
        yield* Effect.forkIn(revoke(stored.value.refreshToken), scope, { startImmediately: true });
    });

  return GoogleAuth.of({
    clientStatus: clients.status,
    setClient: clients.set,
    clearClient: clients.clear,
    clientChanges: clients.changes,
    connect,
    completeConnect,
    client: (sub) =>
      makeGoogleCalendarClient({ http, accessToken: (rejected) => accessToken(sub, rejected) }),
    hasTokens,
    removeTokens,
  });
});

export const layer = Layer.effect(GoogleAuth, make());
