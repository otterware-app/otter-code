import { describe, expect, it } from "vite-plus/test";

import {
  googleAuthorizationRequest,
  googleCallbackUrl,
  googleLoopbackRedirectUri,
  handleGoogleCallbackRequest,
  type GoogleCallbackResponse,
} from "./googleAuthCallback.ts";

const state = "s".repeat(43);
const redirectUri = googleLoopbackRedirectUri(54_213);

const authorizationUrl = (overrides: Record<string, string> = {}) => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: "1234-abc.apps.googleusercontent.com",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email",
    state,
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
    ...overrides,
  }).toString();
  return url.toString();
};

const callback = (params: Record<string, string>, base = `${redirectUri}/`) => {
  const url = new URL(base);
  url.search = new URLSearchParams(params).toString();
  return url.toString();
};

describe("googleAuthorizationRequest", () => {
  it("accepts Google's authorize endpoint with PKCE and a loopback redirect", () => {
    expect(googleAuthorizationRequest(authorizationUrl())).toMatchObject({ redirectUri, state });
  });

  it.each([
    ["another host", authorizationUrl().replace("accounts.google.com", "accounts.evil.test")],
    ["a non-loopback redirect", authorizationUrl({ redirect_uri: "http://192.168.1.2:5000" })],
    ["a redirect with a path", authorizationUrl({ redirect_uri: `${redirectUri}/other` })],
    ["plain PKCE", authorizationUrl({ code_challenge_method: "plain" })],
    ["a foreign client", authorizationUrl({ client_id: "someone-else" })],
    ["a short state", authorizationUrl({ state: "abc" })],
  ])("rejects %s", (_, url) => {
    expect(() => googleAuthorizationRequest(url)).toThrow("Invalid Google sign-in request.");
  });
});

describe("googleCallbackUrl", () => {
  it("accepts the flow's code, with or without the trailing slash and issuer", () => {
    const url = callback({
      state,
      code: "4/0Abc",
      scope: "email",
      iss: "https://accounts.google.com",
    });
    expect(googleCallbackUrl(url, redirectUri, state).searchParams.get("code")).toBe("4/0Abc");
    expect(() =>
      googleCallbackUrl(`${redirectUri}?state=${state}&code=x`, redirectUri, state),
    ).not.toThrow();
  });

  it("accepts an error answer such as a declined consent", () => {
    const url = callback({ state, error: "access_denied" });
    expect(googleCallbackUrl(url, redirectUri, state).searchParams.get("error")).toBe(
      "access_denied",
    );
  });

  it.each([
    ["the wrong state", callback({ state: "x".repeat(43), code: "c" })],
    ["a missing state", callback({ code: "c" })],
    ["the wrong path", callback({ state, code: "c" }, `${redirectUri}/oauth2/callback`)],
    ["the wrong port", callback({ state, code: "c" }, "http://127.0.0.1:54214/")],
    ["both a code and an error", callback({ state, code: "c", error: "access_denied" })],
    ["neither a code nor an error", callback({ state })],
    ["another issuer", callback({ state, code: "c", iss: "https://evil.test" })],
    ["something that is not a URL", "code=c"],
  ])("rejects %s", (_, url) => {
    expect(() => googleCallbackUrl(url, redirectUri, state)).toThrow(
      "does not belong to the current Google sign-in",
    );
  });
});

describe("handleGoogleCallbackRequest", () => {
  const respond = (method: string, url: string) => {
    const written: { status?: number; body?: string | undefined; headers: Record<string, string> } =
      {
        headers: {},
      };
    const response: GoogleCallbackResponse = {
      setHeader: (name, value) => (written.headers[name] = value),
      writeHead: (status) => {
        written.status = status;
        return { end: (body) => (written.body = body) };
      },
    };
    const result = handleGoogleCallbackRequest({ method, url }, response, redirectUri, state);
    return { result, written };
  };

  it("answers the redirect with a page that never echoes the code", () => {
    const { result, written } = respond("GET", `/?state=${state}&code=secret-code`);
    expect(result?.searchParams.get("code")).toBe("secret-code");
    expect(written.status).toBe(200);
    expect(written.headers["cache-control"]).toBe("no-store");
    expect(written.body).not.toContain("secret-code");
  });

  it("ignores other paths and foreign redirects", () => {
    expect(respond("GET", "/favicon.ico")).toMatchObject({
      result: undefined,
      written: { status: 404 },
    });
    expect(respond("GET", `/?state=${"x".repeat(43)}&code=c`)).toMatchObject({
      result: undefined,
      written: { status: 400 },
    });
    expect(respond("POST", `/?state=${state}&code=c`).result).toBeUndefined();
  });
});
