import { createLocalJWKSet, jwtVerify } from "jose";
import { and, eq, ne } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as tables from "../persistence/schema.ts";
import { unlinkEnvironmentRecord } from "../environments/EnvironmentUnlink.ts";

const Jwks = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      kty: Schema.String,
      kid: Schema.optionalKey(Schema.String),
      alg: Schema.optionalKey(Schema.String),
      n: Schema.optionalKey(Schema.String),
      e: Schema.optionalKey(Schema.String),
    }),
  ),
});
const Deletion = Schema.Struct({
  sub: Schema.String,
  event: Schema.Literal("otter.account.delete"),
  iat: Schema.Int,
  exp: Schema.Int,
  jti: Schema.String,
});
const decodeDeletion = Schema.decodeUnknownEffect(Deletion);
export class AccountDeletionError extends Schema.TaggedError<AccountDeletionError>()(
  "AccountDeletionError",
  { stage: Schema.Literals(["verify", "cleanup"]), cause: Schema.Defect() },
) {}
export class AccountLifecycle extends Context.Service<
  AccountLifecycle,
  {
    readonly deleteAccount: (token: string) => Effect.Effect<void, AccountDeletionError>;
  }
>()("t3code-relay/auth/AccountLifecycle") {}
export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const db = yield* RelayDb.RelayDb;
  const transactions = yield* RelayDb.RelayTransactions;
  // Capture the unlink dependencies at service construction, not in the transport.
  const unlinkContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof unlinkEnvironmentRecord>>>();
  return AccountLifecycle.of({
    deleteAccount: Effect.fn("relay.accounts.delete")(function* (token) {
      const claims = yield* Effect.gen(function* () {
        const keys = yield* client
          .get(`${config.accountsUrl}/jwks`)
          .pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Jwks)),
            Effect.timeout("10 seconds"),
          );
        const verified = yield* Effect.tryPromise({
          try: () =>
            jwtVerify(token, createLocalJWKSet({ keys: keys.keys.map((key) => ({ ...key })) }), {
              issuer: config.accountsUrl,
              audience: "otter-code",
              algorithms: ["RS256"],
            }),
          catch: (cause) => new AccountDeletionError({ stage: "verify", cause }),
        });
        const claims = yield* decodeDeletion(verified.payload);
        if (claims.exp - claims.iat > 60 || claims.exp <= claims.iat)
          return yield* Effect.fail(
            new AccountDeletionError({ stage: "verify", cause: "invalid_lifetime" }),
          );
        return claims;
      }).pipe(Effect.mapError((cause) => new AccountDeletionError({ stage: "verify", cause })));
      yield* Effect.gen(function* () {
        // Include revoked links and partially torn-down allocations so retries finish cleanup.
        const links = yield* db
          .select()
          .from(tables.relayEnvironmentLinks)
          .where(eq(tables.relayEnvironmentLinks.userId, claims.sub));
        const allocations = yield* db
          .select()
          .from(tables.relayManagedEndpointAllocations)
          .where(eq(tables.relayManagedEndpointAllocations.userId, claims.sub));
        for (const environmentId of new Set(
          [...links, ...allocations].map((row) => row.environmentId),
        ))
          yield* unlinkEnvironmentRecord({
            userId: claims.sub,
            environmentId,
            managedEndpointNamespace: config.managedEndpointNamespace,
          }).pipe(Effect.provide(unlinkContext));
        yield* transactions.withTransaction(
          Effect.gen(function* () {
            for (const link of links) {
              const remaining = yield* db
                .select()
                .from(tables.relayEnvironmentLinks)
                .where(
                  and(
                    eq(tables.relayEnvironmentLinks.environmentId, link.environmentId),
                    eq(
                      tables.relayEnvironmentLinks.environmentPublicKey,
                      link.environmentPublicKey,
                    ),
                    ne(tables.relayEnvironmentLinks.userId, claims.sub),
                  ),
                );
              if (remaining.length === 0) {
                for (const table of [
                  tables.relayEnvironmentCredentials,
                  tables.relayAgentActivityRows,
                ])
                  yield* db
                    .delete(table)
                    .where(
                      and(
                        eq(table.environmentId, link.environmentId),
                        eq(table.environmentPublicKey, link.environmentPublicKey),
                      ),
                    );
              }
            }
            for (const table of [
              tables.relayLiveActivities,
              tables.relayMobileDevices,
              tables.relayDeliveryAttempts,
              tables.relayLinearUserLinks,
              tables.relayLinearUserTokens,
              tables.relayLinearAgentSessions,
              tables.relayManagedTunnelLimits,
              tables.relayEnvironmentLinks,
            ])
              yield* db.delete(table).where(eq(table.userId, claims.sub));
            // Workspace installations are shared; detach attribution while preserving other members' access.
            yield* db
              .update(tables.relayLinearInstallations)
              .set({ installedByUserId: "deleted-account" })
              .where(eq(tables.relayLinearInstallations.installedByUserId, claims.sub));
          }),
        );
      }).pipe(Effect.mapError((cause) => new AccountDeletionError({ stage: "cleanup", cause })));
    }),
  });
});
export const layer = Layer.effect(AccountLifecycle, make);
export const routes = HttpRouter.add(
  "POST",
  "/v1/identity/delete",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return HttpServerResponse.empty({ status: 401 });
    const service = yield* AccountLifecycle;
    return yield* service.deleteAccount(header.slice(7)).pipe(
      Effect.as(HttpServerResponse.empty({ status: 204 })),
      Effect.catch((error) =>
        Effect.succeed(HttpServerResponse.empty({ status: error.stage === "verify" ? 401 : 503 })),
      ),
    );
  }),
);
