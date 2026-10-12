import { describe, expect, it } from "vite-plus/test";
import { googleAuthorizationRequest } from "../googleAuthCallback.ts";
import { mailGoogleAuthorizationRequest } from "./mailGoogleAuth.ts";

function request(state: string) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: "1234-test.apps.googleusercontent.com",
    redirect_uri: "http://127.0.0.1:42813",
    response_type: "code",
    state,
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

describe("Mail Google authorization compatibility", () => {
  it("keeps local browser links unchanged and makes Mail's nonce compatible with the native helper", () => {
    const original = request("m".repeat(22));
    const flow = mailGoogleAuthorizationRequest(original);
    expect(flow.authorizationUrl).toBe(original);
    expect(flow.state).toBe("m".repeat(22));
    expect(googleAuthorizationRequest(flow.nativeAuthorizationUrl)).toMatchObject({
      state: flow.nativeState,
      redirectUri: flow.redirectUri,
    });
  });

  it("also supports a longer nonce without changing the browser handoff", () => {
    const original = request("m".repeat(43));
    const flow = mailGoogleAuthorizationRequest(original);
    expect(flow.nativeAuthorizationUrl).toBe(original);
    expect(flow.nativeState).toBe(flow.state);
  });

  it.each([
    request("short"),
    `${request("m".repeat(22))}&state=duplicate`,
    request("m".repeat(22)).replace("accounts.google.com", "accounts.evil.test"),
    request("m".repeat(22)).replace("code_challenge_method=S256", "code_challenge_method=plain"),
  ])("rejects malformed Google requests", (url) => {
    expect(() => mailGoogleAuthorizationRequest(url)).toThrow("Invalid Google sign-in request.");
  });
});
