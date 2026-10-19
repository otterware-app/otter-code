import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { availability, encrypt, decrypt } = vi.hoisted(() => ({
  availability: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: availability,
    encryptString: encrypt,
    decryptString: decrypt,
  },
}));

import * as ElectronSafeStorage from "./ElectronSafeStorage.ts";

beforeEach(() => {
  availability.mockReset();
  encrypt.mockReset();
  decrypt.mockReset();
});

describe("ElectronSafeStorage", () => {
  it.effect("honors a denied dev Keychain across independent reads and writes", () =>
    Effect.gen(function* () {
      availability.mockReturnValue(false);
      const storage = yield* ElectronSafeStorage.make;
      expect(yield* storage.isEncryptionAvailable).toBe(false);
      expect(yield* storage.isEncryptionAvailable).toBe(false);
      expect((yield* storage.encryptString("test value").pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* storage.decryptString(new Uint8Array([1])).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(availability).toHaveBeenCalledTimes(1);
      expect(encrypt).not.toHaveBeenCalled();
      expect(decrypt).not.toHaveBeenCalled();
    }).pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Environment, {
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      }),
    ),
  );

  it.effect("continues to encrypt and decrypt with the real dev Keychain when available", () =>
    Effect.gen(function* () {
      availability.mockReturnValue(true);
      const encrypted = Buffer.from([1, 2, 3]);
      encrypt.mockReturnValue(encrypted);
      decrypt.mockReturnValue("test value");
      const storage = yield* ElectronSafeStorage.make;
      expect(yield* storage.encryptString("test value")).toEqual(encrypted);
      expect(yield* storage.decryptString(encrypted)).toBe("test value");
      expect(encrypt).toHaveBeenCalledWith("test value");
      expect(decrypt).toHaveBeenCalledWith(encrypted);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Environment, {
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      }),
    ),
  );

  it.effect("keeps production Keychain availability recoverable without restarting", () =>
    Effect.gen(function* () {
      availability.mockReturnValueOnce(false).mockReturnValueOnce(true);
      const storage = yield* ElectronSafeStorage.make;
      expect(yield* storage.isEncryptionAvailable).toBe(false);
      expect(yield* storage.isEncryptionAvailable).toBe(true);
      expect(availability).toHaveBeenCalledTimes(2);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Environment, {}),
    ),
  );
});
