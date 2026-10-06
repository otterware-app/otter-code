import { afterEach, expect, it, vi } from "vite-plus/test";
import { hasCloudPublicConfig, resolveCloudPublicConfig } from "./publicConfig";
afterEach(() => vi.unstubAllEnvs());
it("requires a secure account issuer and relay origin", () => {
  vi.stubEnv("VITE_ACCOUNTS_URL", "https://accounts.otterware.app/v1/auth/");
  vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.code.otterware.app");
  expect(hasCloudPublicConfig()).toBe(true);
  expect(resolveCloudPublicConfig().accountsUrl).toBe("https://accounts.otterware.app/v1/auth");
  for (const value of [
    "",
    "pk_test_example",
    "http://accounts.example/v1/auth",
    "https://user:secret@accounts.example/v1/auth",
    "https://accounts.example/v1/auth?token=secret",
  ]) {
    vi.stubEnv("VITE_ACCOUNTS_URL", value);
    expect(hasCloudPublicConfig()).toBe(false);
  }
});
