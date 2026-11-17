import { expect, it, vi } from "vite-plus/test";
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
import { resolveCloudPublicConfig, hasTracingPublicConfig } from "./publicConfig";
it("normalizes the shared issuer and rejects insecure cloud endpoints", () => {
  expect(
    resolveCloudPublicConfig({
      accounts: { url: "https://accounts.otterware.app/v1/auth/" },
      relay: { url: "https://relay.code.otterware.app" },
    }).accounts.url,
  ).toBe("https://accounts.otterware.app/v1/auth");
  expect(
    resolveCloudPublicConfig({
      accounts: { url: "pk_test_example" },
      relay: { url: "http://relay.test" },
    }),
  ).toMatchObject({ accounts: { url: null }, relay: { url: null } });
  expect(hasTracingPublicConfig(resolveCloudPublicConfig())).toBe(false);
});
