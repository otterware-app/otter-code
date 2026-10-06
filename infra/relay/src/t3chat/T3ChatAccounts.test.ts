import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as RelayConfiguration from "../Config.ts";
import * as T3ChatAccounts from "./T3ChatAccounts.ts";

const SECRET = "shared-link-secret";

const relaySettings = (
  t3Chat: RelayConfiguration.T3ChatSettings | null,
): RelayConfiguration.RelayConfiguration["Service"] => ({
  relayIssuer: "https://relay.example.test",
  apns: null,
  accountsUrl: "https://accounts.example.test",
  apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
  cloudMintPublicKey: "cloud-mint-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
  ...(t3Chat ? { t3Chat } : {}),
});

const fakeT3Chat = (body: unknown, status = 200) => {
  const requests: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      requests.push({
        url: request.url,
        authorization: request.headers["authorization"],
        body:
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : null,
      });
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  return { client, requests };
};

const provide = (
  client: HttpClient.HttpClient,
  t3Chat: RelayConfiguration.T3ChatSettings | null = {
    baseUrl: "https://chat.example.test",
    linkSecret: Redacted.make(SECRET),
  },
) =>
  Effect.provide(
    T3ChatAccounts.layer.pipe(
      Layer.provide(RelayConfiguration.layer(relaySettings(t3Chat))),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    ),
  );

describe("T3ChatAccounts", () => {
  it.effect("cannot create a link for an Otter account", () =>
    Effect.gen(function* () {
      const accounts = yield* T3ChatAccounts.T3ChatAccounts;
      const error = yield* Effect.flip(accounts.createLinkUrl({ userId: "user_1" }));
      expect(error._tag).toBe("ClerkUserLookupFailed");
    }).pipe(provide(fakeT3Chat({}).client)),
  );

  it.effect("asks T3 Chat for the link with the shared secret", () => {
    const t3Chat = fakeT3Chat({ link: { email: "theo@t3.chat", plan: "premier", linkedAt: 1 } });
    return Effect.gen(function* () {
      const accounts = yield* T3ChatAccounts.T3ChatAccounts;
      const link = yield* accounts.getLink({ userId: "user_1" });
      expect(link).toEqual({ email: "theo@t3.chat", plan: "premier" });
      expect(t3Chat.requests).toEqual([
        {
          url: "https://chat.example.test/api/t3code/link",
          authorization: `Bearer ${SECRET}`,
          body: { clerkUserId: "user_1" },
        },
      ]);
    }).pipe(provide(t3Chat.client));
  });

  it.effect("fails instead of guessing when T3 Chat errors", () =>
    Effect.gen(function* () {
      const accounts = yield* T3ChatAccounts.T3ChatAccounts;
      const error = yield* Effect.flip(accounts.getLink({ userId: "user_1" }));
      expect(error._tag).toBe("T3ChatRequestFailed");
    }).pipe(provide(fakeT3Chat({ error: "nope" }, 401).client)),
  );

  it.effect("times out when T3 Chat stalls while sending the body", () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(new ReadableStream({ start: () => {} }), { status: 200 }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const accounts = yield* T3ChatAccounts.T3ChatAccounts;
      const fiber = yield* Effect.forkChild(Effect.flip(accounts.getLink({ userId: "user_1" })));
      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error._tag).toBe("T3ChatRequestFailed");
    }).pipe(provide(client));
  });

  it.effect("reports itself unavailable without a shared secret", () =>
    Effect.gen(function* () {
      const accounts = yield* T3ChatAccounts.T3ChatAccounts;
      expect(accounts.available).toBe(false);
      const error = yield* Effect.flip(accounts.getLink({ userId: "user_1" }));
      expect(error._tag).toBe("T3ChatNotConfigured");
    }).pipe(provide(fakeT3Chat({}).client, null)),
  );
});
