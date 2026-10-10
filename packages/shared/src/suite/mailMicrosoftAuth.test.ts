import { describe, expect, it } from "vite-plus/test";
import { mailMicrosoftAuthorizationRequest, mailMicrosoftCallbackUrl } from "./mailMicrosoftAuth.ts";

const redirectUri = "http://localhost:42813";
const state = "m".repeat(22);
function authorizationUrl() {
  const url = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  url.search = new URLSearchParams({
    client_id: "1234-test-client",
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "query",
    state,
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
  }).toString();
  return url;
}

describe("Mail's Microsoft callback boundary", () => {
  it("accepts Microsoft's localhost PKCE request", () => {
    expect(mailMicrosoftAuthorizationRequest(authorizationUrl().toString())).toEqual({
      authorizationUrl: authorizationUrl().toString(),
      redirectUri,
      state,
    });
  });
  it.each([
    ["redirect_uri", "https://example.test"],
    ["redirect_uri", "http://localhost:65536"],
    ["redirect_uri", "http://127.0.0.1:42813"],
    ["state", "short"],
    ["code_challenge_method", "plain"],
    ["code_challenge", "short"],
    ["response_type", "token"],
    ["response_mode", "fragment"],
  ])("rejects an invalid %s", (key, value) => {
    const url = authorizationUrl();
    url.searchParams.set(key, value);
    expect(() => mailMicrosoftAuthorizationRequest(url.toString())).toThrow("Invalid");
  });
  it("rejects a duplicate redirect and a foreign authorization server", () => {
    const url = authorizationUrl();
    url.searchParams.append("redirect_uri", redirectUri);
    expect(() => mailMicrosoftAuthorizationRequest(url.toString())).toThrow("Invalid");
    const foreign = authorizationUrl();
    foreign.hostname = "example.test";
    expect(() => mailMicrosoftAuthorizationRequest(foreign.toString())).toThrow("Invalid");
  });
  it.each(["code=test-code", "error=access_denied"])(
    "accepts a matching callback with %s",
    (result) => {
      const url = `${redirectUri}/?state=${state}&${result}`;
      expect(mailMicrosoftCallbackUrl(url, redirectUri, state).toString()).toBe(url);
    },
  );
  it.each([
    `http://localhost:42814/?state=${state}&code=a`,
    `${redirectUri}/other?state=${state}&code=a`,
    `${redirectUri}/?state=old&code=a`,
    `${redirectUri}/?state=${state}&state=${state}&code=a`,
    `${redirectUri}/?state=${state}&code=a&code=b`,
    `${redirectUri}/?state=${state}&code=a&error=access_denied`,
    `${redirectUri}/?state=${state}&code=a&iss=https://example.test`,
    `${redirectUri}/?state=${state}&code=a#fragment`,
  ])("rejects a callback outside the pending flow", (url) => {
    expect(() => mailMicrosoftCallbackUrl(url, redirectUri, state)).toThrow("does not belong");
  });
});
