// @effect-diagnostics globalFetchInEffect:off -- A system-browser stub sends real HTTP callbacks to the scoped native listener.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Account from "./DesktopAccountSession.ts";
import * as Environment from "./DesktopEnvironment.ts";
import * as SafeStorage from "../electron/ElectronSafeStorage.ts";
import * as Shell from "../electron/ElectronShell.ts";
const saved = JSON.stringify({
  version: 1,
  accountsUrl: "https://accounts.otterware.app/v1/auth",
  resource: "https://relay.code.otterware.app",
  clientId: "otter-code-desktop",
  accessToken: "private-access",
  refreshToken: "private-refresh",
  expiresAt: 900000,
  user: { id: "canonical", email: "person@example.test", name: null, image: null },
});
function dependencies(
  stateDir: string,
  backend: string | null = null,
  open: (url: unknown) => Effect.Effect<boolean> = () => Effect.succeed(true),
) {
  return Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(Environment.DesktopEnvironment, {
      clientStateDir: stateDir,
    } as Environment.DesktopEnvironment["Service"]),
    Layer.succeed(SafeStorage.ElectronSafeStorage, {
      isEncryptionAvailable: Effect.succeed(true),
      selectedStorageBackend: Effect.succeed(Option.fromNullishOr(backend)),
      encryptString: (value) =>
        Effect.sync(() => {
          expect(value).toBe(saved);
          return new Uint8Array([0xff, 0, 0x81]);
        }),
      decryptString: (value) =>
        Effect.sync(() => {
          expect(Array.from(value)).toEqual([0xff, 0, 0x81]);
          return saved;
        }),
    }),
    Layer.mock(Shell.ElectronShell)({ openExternal: open }),
  );
}
it.live(
  "stores only encrypted bytes, restores the session and removes credentials on sign-out",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "otter-account-test-" });
        yield* Effect.gen(function* () {
          const account = yield* Account.DesktopAccountSession;
          expect(yield* account.read).toBeNull();
          yield* account.write(saved);
          expect(Array.from(yield* fs.readFile(`${stateDir}/otter-account-session.bin`))).toEqual([
            0xff, 0, 0x81,
          ]);
          expect(yield* account.read).toBe(saved);
          yield* account.write(null);
          expect(yield* account.read).toBeNull();
        }).pipe(Effect.provide(Account.layer.pipe(Layer.provide(dependencies(stateDir)))));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
it.live("treats a session it cannot decrypt as signed out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "otter-account-test-" });
      yield* fs.writeFile(`${stateDir}/otter-account-session.bin`, new Uint8Array([1, 2, 3]));
      const undecryptable = Layer.mock(SafeStorage.ElectronSafeStorage)({
        decryptString: () =>
          Effect.fail(
            new SafeStorage.ElectronSafeStorageDecryptError({ cause: new Error("wrong key") }),
          ),
      });
      const account = yield* Account.DesktopAccountSession.pipe(
        Effect.provide(
          Account.layer.pipe(Layer.provide(undecryptable), Layer.provide(dependencies(stateDir))),
        ),
      );
      expect(yield* account.read).toBeNull();
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
it.live("refuses Linux plaintext storage and malformed credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "otter-account-test-" });
      yield* Effect.gen(function* () {
        const account = yield* Account.DesktopAccountSession;
        expect((yield* account.write(saved).pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* account.write("{}").pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* fs.exists(`${stateDir}/otter-account-session.bin`)).toBe(false);
      }).pipe(
        Effect.provide(Account.layer.pipe(Layer.provide(dependencies(stateDir, "basic_text")))),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
it.live(
  "accepts only the state and issuer of its loopback authorization and closes the listener",
  () =>
    Effect.gen(function* () {
      let callbackUrl = "";
      const open = (raw: unknown) =>
        Effect.promise(async () => {
          const authorization = new URL(String(raw));
          expect(authorization.searchParams.get("client_id")).toBe("otter-code-desktop");
          expect(authorization.searchParams.get("resource")).toBe(
            "https://relay.code.otterware.app",
          );
          expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
          callbackUrl = authorization.searchParams.get("redirect_uri")!;
          const callback = new URL(callbackUrl);
          callback.search = new URLSearchParams({
            code: "code",
            state: "wrong",
            iss: "https://accounts.otterware.app/v1/auth",
          }).toString();
          expect((await fetch(callback)).status).toBe(400);
          callback.searchParams.set("state", "state");
          callback.searchParams.set("iss", "https://other.example/v1/auth");
          expect((await fetch(callback)).status).toBe(400);
          callback.searchParams.set("iss", "https://accounts.otterware.app/v1/auth");
          expect((await fetch(callback)).status).toBe(200);
          return true;
        });
      const result = yield* Effect.gen(function* () {
        const account = yield* Account.DesktopAccountSession;
        return yield* account.authorize({ state: "state", challenge: "challenge" });
      }).pipe(
        Effect.provide(Account.layer.pipe(Layer.provide(dependencies("/unused", null, open)))),
      );
      expect(result).toEqual({ code: "code", redirectUri: callbackUrl });
      yield* Effect.promise(async () => {
        await expect(fetch(callbackUrl)).rejects.toThrow();
      });
    }),
);
