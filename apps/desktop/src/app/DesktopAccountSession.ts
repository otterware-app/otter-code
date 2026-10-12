// @effect-diagnostics nodeBuiltinImport:off -- Electron owns the native OAuth loopback listener.
import * as NodeHttp from "node:http";
import { OtterAccountSession } from "@t3tools/contracts/accounts";
import {
  ACCOUNT_CLIENT_IDS,
  OTTER_ACCOUNTS_URL,
  OTTER_CODE_RELAY_URL,
  normalizeAccountsUrl,
  accountAuthorizationUrl,
} from "@t3tools/shared/otterAccounts";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";

declare const __T3CODE_BUILD_ACCOUNTS_URL__: string | undefined;
declare const __T3CODE_BUILD_RELAY_URL__: string | undefined;
const accountsUrl =
  normalizeAccountsUrl(
    typeof __T3CODE_BUILD_ACCOUNTS_URL__ === "undefined"
      ? OTTER_ACCOUNTS_URL
      : (__T3CODE_BUILD_ACCOUNTS_URL__ ?? ""),
  ) ?? OTTER_ACCOUNTS_URL;
const relayUrl =
  normalizeSecureRelayUrl(
    typeof __T3CODE_BUILD_RELAY_URL__ === "undefined"
      ? OTTER_CODE_RELAY_URL
      : (__T3CODE_BUILD_RELAY_URL__ ?? ""),
  ) ?? OTTER_CODE_RELAY_URL;

export class DesktopAccountSessionError extends Schema.TaggedError<DesktopAccountSessionError>()(
  "DesktopAccountSessionError",
  { operation: Schema.Literals(["read", "write", "authorize"]), cause: Schema.Defect() },
) {
  override get message() {
    return `Could not ${this.operation} the Otter account session.`;
  }
}

export class DesktopAccountSession extends Context.Service<
  DesktopAccountSession,
  {
    readonly read: Effect.Effect<string | null, DesktopAccountSessionError>;
    readonly write: (value: string | null) => Effect.Effect<void, DesktopAccountSessionError>;
    readonly authorize: (request: {
      readonly state: string;
      readonly challenge: string;
    }) => Effect.Effect<
      {
        readonly code: string;
        readonly redirectUri: string;
      },
      DesktopAccountSessionError
    >;
  }
>()("@t3tools/desktop/app/DesktopAccountSession") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const shell = yield* ElectronShell.ElectronShell;
  const lock = yield* Semaphore.make(1);
  const file = path.join(environment.clientStateDir, "otter-account-session.bin");
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(OtterAccountSession));
  return DesktopAccountSession.of({
    read: Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return null;
      // A session sealed by another app identity (e.g. copied from Otter Code)
      // cannot be decrypted here; treat it as signed out instead of failing.
      return yield* safeStorage.decryptString(yield* fs.readFile(file)).pipe(
        Effect.catchTags({
          ElectronSafeStorageDecryptError: (error) =>
            Effect.logWarning("Otter account session could not be decrypted; signed out", {
              error: error.message,
            }).pipe(Effect.as(null)),
        }),
      );
    }).pipe(
      Effect.mapError((cause) => new DesktopAccountSessionError({ operation: "read", cause })),
    ),
    write: (value) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            if (value === null) {
              yield* fs.remove(file, { force: true });
              return;
            }
            yield* decode(value);
            const backend = yield* safeStorage.selectedStorageBackend;
            if (
              Option.getOrNull(backend) === "basic_text" ||
              !(yield* safeStorage.isEncryptionAvailable)
            )
              return yield* Effect.fail("encryption_unavailable");
            const encrypted = yield* safeStorage.encryptString(value);
            yield* fs.makeDirectory(environment.clientStateDir, { recursive: true });
            const temporary = `${file}.tmp`;
            yield* fs.writeFile(temporary, encrypted, { mode: 0o600 });
            yield* fs.rename(temporary, file);
          }),
        )
        .pipe(
          Effect.mapError((cause) => new DesktopAccountSessionError({ operation: "write", cause })),
        ),
    authorize: (request) =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* Effect.acquireRelease(
            Effect.sync(() => NodeHttp.createServer()),
            (server) =>
              Effect.sync(() => {
                server.closeAllConnections();
                server.close();
              }),
          );
          const redirectUri = yield* Effect.tryPromise({
            try: () =>
              new Promise<string>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                  const address = server.address();
                  if (!address || typeof address === "string") {
                    reject(new Error("missing_listener"));
                    return;
                  }
                  server.removeListener("error", reject);
                  resolve(`http://127.0.0.1:${address.port}/callback`);
                });
              }),
            catch: (cause) => new DesktopAccountSessionError({ operation: "authorize", cause }),
          });
          const callback = new Promise<string>((resolve, reject) => {
            server.on("request", (incoming, response) => {
              const url = new URL(incoming.url ?? "/", redirectUri);
              if (
                incoming.method !== "GET" ||
                url.pathname !== "/callback" ||
                url.searchParams.get("state") !== request.state ||
                url.searchParams.get("iss") !== accountsUrl
              ) {
                response.writeHead(400);
                response.end("Invalid sign-in request.");
                return;
              }
              const code = url.searchParams.get("code");
              response.setHeader("content-type", "text/plain; charset=utf-8");
              response.setHeader("cache-control", "no-store");
              response.end(
                code
                  ? "You can return to Otter Code."
                  : "Sign-in was cancelled. Return to Otter Code to try again.",
              );
              if (code) resolve(code);
              else reject(new Error("sign_in_cancelled"));
            });
          });
          void callback.catch(() => {});
          yield* shell.openExternal(
            accountAuthorizationUrl({
              accountsUrl,
              resource: relayUrl,
              clientId: ACCOUNT_CLIENT_IDS.desktop,
              redirectUri,
              ...request,
            }),
          );
          const code = yield* Effect.tryPromise({
            try: () => callback,
            catch: (cause) => new DesktopAccountSessionError({ operation: "authorize", cause }),
          }).pipe(Effect.timeout("10 minutes"));
          return { code, redirectUri };
        }),
      ).pipe(
        Effect.mapError(
          (cause) => new DesktopAccountSessionError({ operation: "authorize", cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(DesktopAccountSession, make);
