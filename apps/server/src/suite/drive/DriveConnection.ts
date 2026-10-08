/**
 * This server's sign-in to Otter Drive: Drive's device authorization for the
 * `otterware-cli` client, the resulting session token kept in the server's
 * secret store (beside the shared data home, never in settings.json), and the
 * status the Drive settings section and pages show.
 */
import {
  DriveAccount,
  type DriveConnectionStatus,
  DriveError,
  DRIVE_DEFAULT_BASE_URL,
} from "@t3tools/contracts/suite";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import type { DriveApi, DriveApiError } from "./DriveApi.ts";

export const DRIVE_SESSION_SECRET = "otterware-drive-session";

/** `OTTERWARE_DRIVE_URL` points the module at another Drive deployment. */
export const DriveBaseUrlConfig = Config.String("OTTERWARE_DRIVE_URL").pipe(
  Config.withDefault(DRIVE_DEFAULT_BASE_URL),
  Config.map((value) => {
    try {
      return new URL(value).origin;
    } catch {
      return DRIVE_DEFAULT_BASE_URL;
    }
  }),
);

const StoredSession = Schema.fromJsonString(
  Schema.Struct({
    baseUrl: Schema.String,
    token: Schema.String,
    account: Schema.NullOr(DriveAccount),
    connectedAt: Schema.String,
  }),
);
const decodeSession = Schema.decodeUnknownOption(StoredSession);
const encodeSession = Schema.encodeSync(StoredSession);

export interface DriveSession {
  readonly token: string;
  readonly account: DriveAccount | null;
}

export const driveNotConnected = () =>
  new DriveError({
    reason: "not_connected",
    detail: "Connect Otter Drive in Settings → Drive to read documents.",
  });

/** Maps an API failure to what clients and agents are told. */
export function driveErrorOf(error: DriveApiError): DriveError {
  if (error.status === 401)
    return new DriveError({
      reason: "not_connected",
      detail: "Otter Drive signed this server out. Connect again in Settings → Drive.",
    });
  if (error.status === 404) return new DriveError({ reason: "not_found", detail: error.detail });
  if (error.status === 403) return new DriveError({ reason: "forbidden", detail: error.detail });
  if (error.status === 409) return new DriveError({ reason: "conflict", detail: error.detail });
  return new DriveError({ reason: "unavailable", detail: error.detail });
}

/** @public Service construction is part of the canonical Effect module API. */
export const makeDriveConnection = (api: DriveApi, baseUrl: string) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const poller = yield* FiberHandle.make<void, never>();

    const readSession = Effect.suspend(() => secrets.get(DRIVE_SESSION_SECRET)).pipe(
      Effect.map((bytes) => {
        if (Option.isNone(bytes)) return null;
        const decoded = decodeSession(new TextDecoder().decode(bytes.value));
        return Option.isSome(decoded) && decoded.value.baseUrl === baseUrl ? decoded.value : null;
      }),
      Effect.orElseSucceed(() => null),
    );

    const initial = yield* readSession;
    const status = yield* SubscriptionRef.make<DriveConnectionStatus>(
      initial === null
        ? { status: "disconnected", baseUrl }
        : { status: "connected", baseUrl, account: initial.account },
    );

    /** The token for API calls, or null while not connected. */
    const session: Effect.Effect<DriveSession | null> = readSession.pipe(
      Effect.map((stored) =>
        stored === null ? null : { token: stored.token, account: stored.account },
      ),
    );

    const requireSession: Effect.Effect<DriveSession, DriveError> = session.pipe(
      Effect.filterOrFail((current) => current !== null, driveNotConnected),
    );

    const storeSession = (token: string, account: DriveAccount | null) =>
      Effect.gen(function* () {
        const connectedAt = DateTime.formatIso(yield* DateTime.now);
        yield* secrets.set(
          DRIVE_SESSION_SECRET,
          new TextEncoder().encode(encodeSession({ baseUrl, token, account, connectedAt })),
        );
        yield* SubscriptionRef.set(status, { status: "connected", baseUrl, account });
      });

    const accountOf = (token: string) =>
      api.me({ token }).pipe(
        Effect.map((me): DriveAccount => ({ userId: me.userId ?? null, name: me.actor.name })),
        Effect.orElseSucceed(() => null),
      );

    /** Polls the device authorization until it is approved, denied or expires. */
    const poll = (deviceCode: string, intervalSeconds: number, expiresAtMs: number) =>
      Effect.gen(function* () {
        let interval = Math.max(intervalSeconds, 1);
        while ((yield* Clock.currentTimeMillis) < expiresAtMs) {
          yield* Effect.sleep(Duration.seconds(interval));
          const result = yield* api
            .deviceToken(deviceCode)
            .pipe(Effect.orElseSucceed(() => ({ _tag: "Pending", slowDown: false }) as const));
          if (result._tag === "Pending") {
            if (result.slowDown) interval += 5;
            continue;
          }
          if (result._tag === "Denied") {
            yield* SubscriptionRef.set(status, {
              status: "error",
              baseUrl,
              message: `Otter Drive did not approve this server: ${result.reason}.`,
            });
            return;
          }
          const account = yield* accountOf(result.accessToken);
          yield* storeSession(result.accessToken, account).pipe(
            Effect.catch(() =>
              SubscriptionRef.set(status, {
                status: "error",
                baseUrl,
                message: "Signed in to Otter Drive, but the session could not be saved.",
              }),
            ),
          );
          yield* Effect.logInfo("Otter Drive connected", { baseUrl });
          return;
        }
        yield* SubscriptionRef.set(status, {
          status: "error",
          baseUrl,
          message: "The Drive sign-in code expired before it was approved. Start again.",
        });
      });

    /** Starts the device flow; the returned status carries the code to enter. */
    const connect = Effect.gen(function* () {
      const code = yield* api.deviceCode.pipe(Effect.mapError(driveErrorOf));
      const now = yield* Clock.currentTimeMillis;
      const expiresAtMs = now + code.expires_in * 1_000;
      const verificationUri = new URL(code.verification_uri, baseUrl).toString();
      const pending: DriveConnectionStatus = {
        status: "pending",
        baseUrl,
        userCode: code.user_code,
        verificationUri,
        verificationUriComplete: new URL(
          code.verification_uri_complete ?? code.verification_uri,
          baseUrl,
        ).toString(),
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAtMs)),
      };
      yield* SubscriptionRef.set(status, pending);
      yield* FiberHandle.run(poller, poll(code.device_code, code.interval ?? 5, expiresAtMs));
      return pending;
    });

    const disconnect = Effect.gen(function* () {
      yield* FiberHandle.clear(poller);
      yield* secrets.remove(DRIVE_SESSION_SECRET).pipe(Effect.ignore);
      const next: DriveConnectionStatus = { status: "disconnected", baseUrl };
      yield* SubscriptionRef.set(status, next);
      return next;
    });

    /** Drive rejected the token (signed out, session expired): forget it and say so. */
    const markRejected = Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(status);
      if (current.status !== "connected") return;
      yield* secrets.remove(DRIVE_SESSION_SECRET).pipe(Effect.ignore);
      yield* SubscriptionRef.set(status, {
        status: "error",
        baseUrl,
        message: "Otter Drive signed this server out. Connect again.",
      });
    });

    /** Fills in the account name for a session stored before it was known. */
    const refreshAccount = Effect.gen(function* () {
      const stored = yield* readSession;
      if (stored === null || stored.account !== null) return;
      const account = yield* accountOf(stored.token);
      if (account !== null) yield* storeSession(stored.token, account).pipe(Effect.ignore);
    });

    return {
      baseUrl,
      session,
      requireSession,
      status: SubscriptionRef.get(status),
      statusChanges: SubscriptionRef.changes(status) as Stream.Stream<DriveConnectionStatus>,
      connect,
      syncAccount: (token: string | null) =>
        token === null
          ? disconnect
          : Effect.gen(function* () {
              if (baseUrl !== DRIVE_DEFAULT_BASE_URL)
                return yield* Effect.fail(
                  new DriveError({
                    reason: "forbidden",
                    detail: "Shared sign-in requires the Otter Drive service.",
                  }),
                );
              yield* FiberHandle.clear(poller);
              const driveToken = yield* api.suiteSession(token).pipe(Effect.mapError(driveErrorOf));
              const account = yield* accountOf(driveToken);
              if (account === null)
                return yield* Effect.fail(
                  new DriveError({
                    reason: "unavailable",
                    detail: "Drive could not validate your Otter account.",
                  }),
                );
              yield* storeSession(driveToken, account).pipe(
                Effect.mapError(
                  () =>
                    new DriveError({
                      reason: "unavailable",
                      detail: "Drive could not save your Otter account session.",
                    }),
                ),
              );
              return yield* SubscriptionRef.get(status);
            }),
      disconnect,
      markRejected,
      refreshAccount,
    };
  });

export type DriveConnection = Effect.Success<ReturnType<typeof makeDriveConnection>>;
