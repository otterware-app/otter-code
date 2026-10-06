import { afterEach, expect, it, vi } from "vite-plus/test";
import { buildConnectCliAuthorizeUrl } from "./connectCliAuth";
afterEach(() => vi.unstubAllEnvs());
it("forwards CLI PKCE to Otter Accounts with a registered public client and relay resource", () => {
  vi.stubEnv("VITE_ACCOUNTS_URL", "https://accounts.otterware.app/v1/auth");
  vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.code.otterware.app");
  const url = new URL(
    buildConnectCliAuthorizeUrl({
      state: "test-state",
      challenge: "test-challenge",
      loopbackPort: 34567,
    })!,
  );
  expect(url.origin).toBe("https://accounts.otterware.app");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    client_id: "otter-code-cli",
    redirect_uri: "http://127.0.0.1:34567/callback",
    state: "test-state",
    code_challenge: "test-challenge",
    code_challenge_method: "S256",
    resource: "https://relay.code.otterware.app",
  });
});
