import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import type { GoogleClientStatus } from "./GoogleAuth.ts";
import * as GoogleOAuthClientConfig from "./GoogleOAuthClientConfig.ts";

const memorySecrets = (values = new Map<string, Uint8Array>()) =>
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

const withEnv = (env: Record<string, string>, secrets = new Map<string, Uint8Array>()) =>
  Effect.provide(
    Layer.mergeAll(memorySecrets(secrets), ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

const build = { clientId: "1-build.apps.googleusercontent.com", clientSecret: "build-secret" };
const environment = {
  T3CODE_GOOGLE_CLIENT_ID: "2-env.apps.googleusercontent.com",
  T3CODE_GOOGLE_CLIENT_SECRET: "env-secret",
};

it.effect("prefers the settings, then the environment, then the build", () =>
  Effect.gen(function* () {
    const config = yield* GoogleOAuthClientConfig.make(build);
    expect(yield* config.status).toEqual({
      configured: true,
      source: "environment",
      clientId: "2-env.apps.googleusercontent.com",
    });

    yield* config.set({ clientId: " 3-own.apps.googleusercontent.com ", clientSecret: "own" });
    expect(yield* config.current).toEqual(
      Option.some({
        clientId: "3-own.apps.googleusercontent.com",
        clientSecret: "own",
        source: "settings",
      }),
    );

    yield* config.clear;
    expect((yield* config.status).source).toBe("environment");
  }).pipe(withEnv(environment)),
);

it.effect("falls back to the build, and needs both an id and a secret", () =>
  Effect.gen(function* () {
    expect((yield* (yield* GoogleOAuthClientConfig.make(build)).status).source).toBe("build");
    const partial = yield* GoogleOAuthClientConfig.make({
      clientId: build.clientId,
      clientSecret: "",
    });
    expect(yield* partial.status).toEqual({ configured: false, source: null, clientId: null });
  }).pipe(withEnv({ T3CODE_GOOGLE_CLIENT_ID: environment.T3CODE_GOOGLE_CLIENT_ID })),
);

it.effect("keeps a client from the settings across restarts", () => {
  const secrets = new Map<string, Uint8Array>();
  return Effect.gen(function* () {
    const first = yield* GoogleOAuthClientConfig.make(build);
    yield* first.set({ clientId: "3-own.apps.googleusercontent.com", clientSecret: "own" });
    const restarted = yield* GoogleOAuthClientConfig.make(build);
    expect((yield* restarted.status).source).toBe("settings");
    expect(secrets.has(GoogleOAuthClientConfig.GOOGLE_OAUTH_CLIENT_SECRET_NAME)).toBe(true);
  }).pipe(withEnv({}, secrets));
});

it.effect("rejects an id that is not a Google OAuth client id", () =>
  Effect.gen(function* () {
    const config = yield* GoogleOAuthClientConfig.make(build);
    const error = yield* Effect.flip(config.set({ clientId: "my-client", clientSecret: "x" }));
    expect(error.code).toBe("invalid");
    expect((yield* config.status).source).toBe("build");
  }).pipe(withEnv({})),
);

it.effect("publishes every change of the status", () =>
  Effect.gen(function* () {
    const config = yield* GoogleOAuthClientConfig.make(build);
    const changes = yield* Queue.unbounded<GoogleClientStatus>();
    // Starting immediately subscribes before the first change is published.
    yield* Stream.runForEach(config.changes, (status) => Queue.offer(changes, status)).pipe(
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* config.set({ clientId: "3-own.apps.googleusercontent.com", clientSecret: "own" });
    expect((yield* Queue.take(changes)).source).toBe("settings");
    yield* config.clear;
    expect((yield* Queue.take(changes)).source).toBe("build");
  }).pipe(withEnv({})),
);
