import { expect, it } from "@effect/vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Lifecycle from "./AccountLifecycle.ts";
import * as Configuration from "../Config.ts";
import * as Db from "../db.ts";
import * as Links from "../environments/EnvironmentLinks.ts";
import * as Credentials from "../environments/EnvironmentCredentials.ts";
import * as Endpoints from "../environments/ManagedEndpointProvider.ts";
import * as Inbox from "../hooks/HookInbox.ts";
import * as tables from "../persistence/schema.ts";
const issuer = "https://accounts.otterware.app/v1/auth";
const keys = await generateKeyPair("RS256");
const publicKey = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256" };
const dialect = new PgDialect();
const params = (where: SQL) => dialect.sqlToQuery(where).params;
const token = Effect.fn(function* (
  overrides: { audience?: string; event?: string; lifetime?: number; expires?: number } = {},
) {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  return yield* Effect.promise(() =>
    new SignJWT({ event: overrides.event ?? "otter.account.delete" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(issuer)
      .setAudience(overrides.audience ?? "otter-code")
      .setSubject("owner")
      .setIssuedAt(now)
      .setExpirationTime(overrides.expires ?? now + (overrides.lifetime ?? 60))
      .setJti("test-request")
      .sign(keys.privateKey),
  );
});
function fixture(shared = false, fail = false) {
  const deleted: Array<{ table: unknown; values: Array<unknown> }> = [];
  const unlinked: Array<unknown> = [];
  const links = [{ userId: "owner", environmentId: "env", environmentPublicKey: "key" }];
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: (where: SQL) =>
          Effect.sync(() => {
            const values = params(where);
            if (values.length > 1) return shared ? [{ userId: "other" }] : [];
            return table === tables.relayEnvironmentLinks ? links : [];
          }),
      }),
    }),
    delete: (table: unknown) => ({
      where: (where: SQL) =>
        Effect.sync(() => {
          deleted.push({ table, values: params(where) });
        }),
    }),
    update: () => ({
      set: () => ({
        where: (where: SQL) =>
          Effect.sync(() => {
            expect(params(where)).toEqual(["owner"]);
          }),
      }),
    }),
  } as unknown as Db.RelayDb["Service"];
  const client = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ keys: [publicKey] }))),
  );
  const deps = Layer.mergeAll(
    Configuration.layer({
      accountsUrl: issuer,
      relayIssuer: "https://relay.code.otterware.app",
      apns: null,
      apnsDeliveryJobSigningSecret: Redacted.make("test"),
      cloudMintPrivateKey: Redacted.make("test"),
      cloudMintPublicKey: "test",
      managedEndpointNamespace: undefined,
      managedEndpointBaseDomain: undefined,
    }),
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Db.RelayDb, db),
    Layer.succeed(Db.RelayTransactions, { withTransaction: (effect) => effect }),
    Layer.mock(Links.EnvironmentLinks)({ getForUser: () => Effect.succeed(null) }),
    Layer.mock(Credentials.EnvironmentCredentials)({}),
    Layer.mock(Inbox.HookInbox)({}),
    Layer.mock(Endpoints.ManagedEndpointProvider)({
      prepareDeprovision: () => Effect.succeed(null),
      deprovision: (input) =>
        fail
          ? Effect.fail(
              new Endpoints.ManagedEndpointDeprovisioningFailed({
                stage: "delete-tunnel",
                userId: "owner",
                environmentId: "env",
                cause: "unavailable",
              }),
            )
          : Effect.sync(() => {
              unlinked.push(input);
              return true;
            }),
    }),
  );
  return {
    deleted,
    unlinked,
    run: (jwt: string) =>
      Effect.gen(function* () {
        const service = yield* Lifecycle.AccountLifecycle;
        return yield* service.deleteAccount(jwt).pipe(Effect.result);
      }).pipe(Effect.provide(Lifecycle.layer.pipe(Layer.provide(deps)))),
  };
}
it.live(
  "rejects unsigned, expired, wrong-app and excessive-lifetime deletion requests before cleanup",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      for (const jwt of [
        "invalid",
        yield* token({ audience: "otter-drive" }),
        yield* token({ event: "wrong" }),
        yield* token({ lifetime: 61 }),
        yield* token({
          expires: Math.floor((yield* Clock.currentTimeMillis) / 1000) - 1,
        }),
      ]) {
        const result = yield* f.run(jwt);
        expect(result._tag).toBe("Failure");
      }
      expect(f.deleted).toEqual([]);
      expect(f.unlinked).toEqual([]);
    }),
);
it.live("cleans the canonical owner's cloud records and preserves shared environment data", () =>
  Effect.gen(function* () {
    const f = fixture(true);
    expect((yield* f.run(yield* token()))._tag).toBe("Success");
    expect(f.unlinked).toEqual([{ userId: "owner", environmentId: "env", target: null }]);
    expect(f.deleted.length).toBeGreaterThan(0);
    expect(f.deleted.every(({ values }) => values.length === 1 && values[0] === "owner")).toBe(
      true,
    );
    expect(f.deleted.some(({ table }) => table === tables.relayAgentActivityRows)).toBe(false);
  }),
);
it.live("removes credentials and cloud thread metadata for an exclusively owned environment", () =>
  Effect.gen(function* () {
    const f = fixture();
    expect((yield* f.run(yield* token()))._tag).toBe("Success");
    expect(f.deleted.find(({ table }) => table === tables.relayAgentActivityRows)?.values).toEqual([
      "env",
      "key",
    ]);
    expect(
      f.deleted.find(({ table }) => table === tables.relayEnvironmentCredentials)?.values,
    ).toEqual(["env", "key"]);
  }),
);
it.live("keeps ownership records available for retry when external teardown fails", () =>
  Effect.gen(function* () {
    const f = fixture(false, true);
    expect((yield* f.run(yield* token()))._tag).toBe("Failure");
    expect(f.deleted).toEqual([]);
  }),
);
