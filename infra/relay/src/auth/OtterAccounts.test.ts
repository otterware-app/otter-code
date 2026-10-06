import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import * as Accounts from "./OtterAccounts.ts";
import * as Configuration from "../Config.ts";
export const config: Configuration.RelayConfiguration["Service"] = {
  accountsUrl: "https://accounts.otterware.app/v1/auth",
  relayIssuer: "https://relay.code.otterware.app",
  apns: null,
  apnsDeliveryJobSigningSecret: Redacted.make("test"),
  cloudMintPrivateKey: Redacted.make("test"),
  cloudMintPublicKey: "test",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};
const user = { id: "canonical-id", email: "person@example.test", name: "Person", image: null };
describe("Otter account token verification", () => {
  it.effect(
    "uses the authoritative account session rather than token subject or email aliases",
    () => {
      const calls: Array<{ url: string; authorization: string | undefined }> = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          calls.push({ url: request.url, authorization: request.headers.authorization });
          return HttpClientResponse.fromWeb(request, Response.json(user));
        }),
      );
      return Effect.gen(function* () {
        const accounts = yield* Accounts.OtterAccounts;
        expect(yield* accounts.verify("opaque-code-grant")).toEqual(user);
        expect(calls).toEqual([
          { url: `${config.accountsUrl}/code/session`, authorization: "Bearer opaque-code-grant" },
        ]);
      }).pipe(
        Effect.provide(
          Accounts.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Configuration.layer(config),
                Layer.succeed(HttpClient.HttpClient, client),
              ),
            ),
          ),
        ),
      );
    },
  );
  it.effect.each([
    new Response(null, { status: 401 }),
    new Response(null, { status: 503 }),
    Response.json({ email: user.email }),
  ])("fails closed for an unavailable or incomplete identity", (response) => {
    const client = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, response.clone())),
    );
    return Effect.gen(function* () {
      const accounts = yield* Accounts.OtterAccounts;
      const failure = yield* accounts.verify("token").pipe(Effect.flip);
      expect(failure._tag).toBe("AccountTokenVerificationFailed");
    }).pipe(
      Effect.provide(
        Accounts.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Configuration.layer(config),
              Layer.succeed(HttpClient.HttpClient, client),
            ),
          ),
        ),
      ),
    );
  });
});
