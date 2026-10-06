// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off - Tests hash the PKCE verifier and call the real loopback listener; Google itself is faked.
import * as NodeCrypto from "node:crypto";
import { assert, describe, expect, it } from "@effect/vitest";
import { googleAuthorizationRequest } from "@t3tools/shared/googleAuthCallback";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import type { GoogleAuthShape, GoogleConnectFlowEvent } from "./GoogleAuth.ts";
import * as GoogleAuthLive from "./GoogleAuthLive.ts";

const CLIENT = { clientId: "1234-test.apps.googleusercontent.com", clientSecret: "test-secret" };
const SUB = "1234567890";
const GRANTED = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
].join(" ");
const EVENT = { id: "evt1", summary: "Standup" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Google's token, userinfo, revoke and Calendar endpoints, scripted per test. */
const fakeGoogle = (
  options: {
    readonly token?: (params: URLSearchParams) => Response;
    readonly api?: (authorization: string | undefined) => Response;
  } = {},
) => {
  const tokenRequests: URLSearchParams[] = [];
  const apiAuthorizations: Array<string | undefined> = [];
  const revoked = Deferred.makeUnsafe<string>();
  const http = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const body = new URLSearchParams(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
      );
      const answer = (() => {
        switch (`${url.origin}${url.pathname}`) {
          case "https://oauth2.googleapis.com/token":
            tokenRequests.push(body);
            return (
              options.token?.(body) ??
              json({
                access_token: "access-1",
                refresh_token: "refresh-1",
                expires_in: 3600,
                scope: GRANTED,
                token_type: "Bearer",
              })
            );
          case "https://openidconnect.googleapis.com/v1/userinfo":
            return json({
              sub: SUB,
              email: "ada@example.com",
              name: "Ada Lovelace",
              picture: "https://example.com/ada.png",
            });
          case "https://oauth2.googleapis.com/revoke":
            Deferred.doneUnsafe(revoked, Effect.succeed(body.get("token") ?? ""));
            return new Response(null, { status: 200 });
          default:
            apiAuthorizations.push(request.headers.authorization);
            return options.api?.(request.headers.authorization) ?? json(EVENT);
        }
      })();
      return HttpClientResponse.fromWeb(request, answer);
    }),
  );
  return { http, tokenRequests, apiAuthorizations, revoked };
};

const memorySecrets = (values: Map<string, Uint8Array>) =>
  Layer.succeed(
    ServerSecretStore,
    ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
      set: (name, value) => Effect.sync(() => void values.set(name, value)),
      create: (name, value) => Effect.sync(() => void values.set(name, value)),
      getOrCreateRandom: (name) => Effect.sync(() => values.get(name) ?? new Uint8Array()),
      remove: (name) => Effect.sync(() => void values.delete(name)),
    }),
  );

const makeAuth = (
  http: HttpClient.HttpClient,
  secrets = new Map<string, Uint8Array>(),
  build = CLIENT,
) =>
  GoogleAuthLive.make(build).pipe(
    Effect.provide(
      Layer.mergeAll(
        memorySecrets(secrets),
        Layer.succeed(HttpClient.HttpClient, http),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
      ),
    ),
  );

const storeTokens = (
  secrets: Map<string, Uint8Array>,
  tokens: { clientId?: string; accessToken?: string; expiresAt?: number } = {},
) =>
  secrets.set(
    GoogleAuthLive.tokenSecretName(SUB),
    new TextEncoder().encode(
      JSON.stringify({
        clientId: tokens.clientId ?? CLIENT.clientId,
        refreshToken: "refresh-1",
        accessToken: tokens.accessToken ?? "expired",
        expiresAt: tokens.expiresAt ?? 0,
        scopes: GRANTED.split(" "),
      }),
    ),
  );

const readTokens = (secrets: Map<string, Uint8Array>) =>
  JSON.parse(new TextDecoder().decode(secrets.get(GoogleAuthLive.tokenSecretName(SUB))));

/** Starts a sign-in and waits for its authorization URL. */
const startFlow = (auth: GoogleAuthShape, loginHint?: string) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<GoogleConnectFlowEvent>();
    const fiber = yield* Stream.runForEach(auth.connect(loginHint ? { loginHint } : {}), (event) =>
      Queue.offer(events, event),
    ).pipe(Effect.forkScoped);
    const waiting = yield* Queue.take(events);
    assert(waiting._tag === "waiting");
    const url = new URL(waiting.authorizationUrl);
    const state = url.searchParams.get("state")!;
    const callback = (params: Record<string, string>) =>
      `${waiting.redirectUri}/?${new URLSearchParams({ state, ...params })}`;
    return { events, fiber, waiting, url, state, callback };
  });

describe("connect", () => {
  it.effect(
    "builds a PKCE authorization URL and signs in with a redirect a client hands back",
    () =>
      Effect.gen(function* () {
        const google = fakeGoogle();
        const secrets = new Map<string, Uint8Array>();
        const auth = yield* makeAuth(google.http, secrets);
        const flow = yield* startFlow(auth, "ada@example.com");

        expect(flow.waiting.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(googleAuthorizationRequest(flow.waiting.authorizationUrl).redirectUri).toBe(
          flow.waiting.redirectUri,
        );
        const params = Object.fromEntries(flow.url.searchParams);
        expect(params).toMatchObject({
          client_id: CLIENT.clientId,
          redirect_uri: flow.waiting.redirectUri,
          response_type: "code",
          scope: GoogleAuthLive.GOOGLE_SCOPES.join(" "),
          code_challenge_method: "S256",
          access_type: "offline",
          prompt: "select_account consent",
          login_hint: "ada@example.com",
        });

        // Pasted from an address bar that hides the scheme.
        yield* auth.completeConnect({
          flowId: flow.waiting.flowId,
          callbackUrl: flow.callback({ code: "the-code", scope: GRANTED }).replace("http://", ""),
        });
        expect(yield* Queue.take(flow.events)).toEqual({ _tag: "exchanging" });
        expect(yield* Queue.take(flow.events)).toEqual({
          _tag: "connected",
          identity: {
            sub: SUB,
            email: "ada@example.com",
            name: "Ada Lovelace",
            picture: "https://example.com/ada.png",
          },
        });
        yield* Fiber.join(flow.fiber);

        const exchange = Object.fromEntries(google.tokenRequests[0]!);
        expect(exchange).toMatchObject({
          grant_type: "authorization_code",
          code: "the-code",
          redirect_uri: flow.waiting.redirectUri,
          client_id: CLIENT.clientId,
          client_secret: CLIENT.clientSecret,
        });
        expect(
          NodeCrypto.createHash("sha256").update(exchange.code_verifier!).digest("base64url"),
        ).toBe(params.code_challenge);
        expect(readTokens(secrets)).toMatchObject({
          clientId: CLIENT.clientId,
          refreshToken: "refresh-1",
          accessToken: "access-1",
        });
        expect(yield* auth.hasTokens(SUB)).toBe(true);
      }),
  );

  it.effect("receives the redirect on its own loopback listener", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth(fakeGoogle().http);
      const flow = yield* startFlow(auth);
      const response = yield* Effect.promise(() => fetch(flow.callback({ code: "listener-code" })));
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).not.toContain("listener-code");
      expect(yield* Queue.take(flow.events)).toEqual({ _tag: "exchanging" });
      expect((yield* Queue.take(flow.events))._tag).toBe("connected");
    }),
  );

  it.effect("rejects a redirect of another sign-in and keeps waiting", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth(fakeGoogle().http);
      const flow = yield* startFlow(auth);
      const foreign = yield* Effect.flip(
        auth.completeConnect({
          flowId: flow.waiting.flowId,
          callbackUrl: `${flow.waiting.redirectUri}/?state=${"x".repeat(43)}&code=c`,
        }),
      );
      expect(foreign.code).toBe("invalid");
      const unknown = yield* Effect.flip(
        auth.completeConnect({ flowId: "gone", callbackUrl: flow.callback({ code: "c" }) }),
      );
      expect(unknown.code).toBe("not_found");

      yield* auth.completeConnect({
        flowId: flow.waiting.flowId,
        callbackUrl: flow.callback({ code: "c" }),
      });
      expect(yield* Queue.take(flow.events)).toEqual({ _tag: "exchanging" });
    }),
  );

  it.effect("reports a declined consent", () =>
    Effect.gen(function* () {
      const google = fakeGoogle();
      const auth = yield* makeAuth(google.http);
      const flow = yield* startFlow(auth);
      yield* auth.completeConnect({
        flowId: flow.waiting.flowId,
        callbackUrl: flow.callback({ error: "access_denied" }),
      });
      expect(yield* Queue.take(flow.events)).toEqual({
        _tag: "failed",
        message: "Google sign-in was cancelled.",
      });
      yield* Fiber.join(flow.fiber);
      expect(google.tokenRequests).toHaveLength(0);
    }),
  );

  it.effect("fails when calendar access was not granted, and stores nothing", () =>
    Effect.gen(function* () {
      const secrets = new Map<string, Uint8Array>();
      const google = fakeGoogle({
        token: () =>
          json({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "openid email" }),
      });
      const auth = yield* makeAuth(google.http, secrets);
      const flow = yield* startFlow(auth);
      yield* auth.completeConnect({
        flowId: flow.waiting.flowId,
        callbackUrl: flow.callback({ code: "c" }),
      });
      yield* Queue.take(flow.events);
      const failed = yield* Queue.take(flow.events);
      assert(failed._tag === "failed");
      expect(failed.message).toContain("needs access to your events and calendar list");
      expect(secrets.size).toBe(0);
    }),
  );

  it.effect("gives up after five minutes", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth(fakeGoogle().http);
      const flow = yield* startFlow(auth);
      yield* TestClock.adjust("5 minutes");
      expect(yield* Queue.take(flow.events)).toEqual({
        _tag: "failed",
        message: "Google sign-in timed out. Start again.",
      });
      yield* Fiber.join(flow.fiber);
      const late = yield* Effect.flip(
        auth.completeConnect({
          flowId: flow.waiting.flowId,
          callbackUrl: flow.callback({ code: "c" }),
        }),
      );
      expect(late.code).toBe("not_found");
    }),
  );

  it.effect("cancels the flow and closes its listener when the client stops listening", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth(fakeGoogle().http);
      const flow = yield* startFlow(auth);
      yield* Fiber.interrupt(flow.fiber);
      const cancelled = yield* Effect.flip(
        auth.completeConnect({
          flowId: flow.waiting.flowId,
          callbackUrl: flow.callback({ code: "c" }),
        }),
      );
      expect(cancelled.code).toBe("not_found");
      const reached = yield* Effect.promise(() =>
        fetch(flow.callback({ code: "c" })).then(
          () => "answered",
          () => "refused",
        ),
      );
      expect(reached).toBe("refused");
    }),
  );

  it.effect("runs concurrent sign-ins independently", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth(fakeGoogle().http);
      const first = yield* startFlow(auth);
      const second = yield* startFlow(auth);
      expect(second.waiting.flowId).not.toBe(first.waiting.flowId);
      expect(second.waiting.redirectUri).not.toBe(first.waiting.redirectUri);
      const crossed = yield* Effect.flip(
        auth.completeConnect({
          flowId: first.waiting.flowId,
          callbackUrl: second.callback({ code: "c" }),
        }),
      );
      expect(crossed.code).toBe("invalid");
      yield* auth.completeConnect({
        flowId: second.waiting.flowId,
        callbackUrl: second.callback({ code: "c" }),
      });
      expect(yield* Queue.take(second.events)).toEqual({ _tag: "exchanging" });
      expect(yield* Queue.size(first.events)).toBe(0);
    }),
  );

  it.effect("needs an OAuth client", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth(fakeGoogle().http, new Map(), {
        clientId: "",
        clientSecret: "",
      });
      expect(yield* auth.clientStatus).toEqual({ configured: false, source: null, clientId: null });
      const error = yield* Effect.flip(Stream.runDrain(auth.connect({})));
      expect(error.code).toBe("not_configured");
    }),
  );
});

describe("tokens", () => {
  it.effect("shares one refresh between concurrent callers and saves the new token", () =>
    Effect.gen(function* () {
      const secrets = new Map<string, Uint8Array>();
      storeTokens(secrets);
      const google = fakeGoogle({
        token: () => json({ access_token: "fresh", expires_in: 3600, token_type: "Bearer" }),
      });
      const client = (yield* makeAuth(google.http, secrets)).client(SUB);
      yield* Effect.all([client.getEvent("primary", "a"), client.getEvent("primary", "b")], {
        concurrency: "unbounded",
      });
      expect(google.tokenRequests).toHaveLength(1);
      expect(Object.fromEntries(google.tokenRequests[0]!)).toEqual({
        grant_type: "refresh_token",
        refresh_token: "refresh-1",
        client_id: CLIENT.clientId,
        client_secret: CLIENT.clientSecret,
      });
      expect(google.apiAuthorizations).toEqual(["Bearer fresh", "Bearer fresh"]);
      expect(readTokens(secrets)).toMatchObject({
        accessToken: "fresh",
        refreshToken: "refresh-1",
      });
    }),
  );

  it.effect("reports a revoked sign-in as signed out and keeps the tokens", () =>
    Effect.gen(function* () {
      const secrets = new Map<string, Uint8Array>();
      storeTokens(secrets);
      const google = fakeGoogle({ token: () => json({ error: "invalid_grant" }, 400) });
      const auth = yield* makeAuth(google.http, secrets);
      const error = yield* Effect.flip(auth.client(SUB).getEvent("primary", "a"));
      expect(error.reason).toBe("signed_out");
      expect(google.apiAuthorizations).toHaveLength(0);
      expect(yield* auth.hasTokens(SUB)).toBe(true);
    }),
  );

  it.effect("treats tokens from another OAuth client as signed out", () =>
    Effect.gen(function* () {
      const secrets = new Map<string, Uint8Array>();
      storeTokens(secrets, { clientId: "999-old.apps.googleusercontent.com" });
      const google = fakeGoogle();
      const auth = yield* makeAuth(google.http, secrets);
      expect((yield* Effect.flip(auth.client(SUB).getEvent("primary", "a"))).reason).toBe(
        "signed_out",
      );
      expect(google.tokenRequests).toHaveLength(0);
      expect(yield* auth.hasTokens(SUB)).toBe(false);
    }),
  );

  it.effect("refreshes a still-valid token that Google rejects", () =>
    Effect.gen(function* () {
      const secrets = new Map<string, Uint8Array>();
      storeTokens(secrets, { accessToken: "stale", expiresAt: 60 * 60_000 });
      const google = fakeGoogle({
        token: () => json({ access_token: "fresh", expires_in: 3600 }),
        api: (authorization) => (authorization === "Bearer stale" ? json({}, 401) : json(EVENT)),
      });
      const auth = yield* makeAuth(google.http, secrets);
      expect(yield* auth.client(SUB).getEvent("primary", "evt1")).toEqual(EVENT);
      expect(google.apiAuthorizations).toEqual(["Bearer stale", "Bearer fresh"]);
      expect(google.tokenRequests).toHaveLength(1);
    }),
  );

  it.effect("forgets and revokes an account's tokens", () =>
    Effect.gen(function* () {
      const secrets = new Map<string, Uint8Array>();
      storeTokens(secrets);
      const google = fakeGoogle();
      const auth = yield* makeAuth(google.http, secrets);
      yield* auth.removeTokens(SUB);
      expect(secrets.size).toBe(0);
      expect(yield* auth.hasTokens(SUB)).toBe(false);
      expect(yield* Deferred.await(google.revoked)).toBe("refresh-1");
    }),
  );
});
