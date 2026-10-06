// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Tests exercise the real native loopback listener without a Google account.
import * as NodeHttp from "node:http";
import { describe, expect, it } from "vite-plus/test";

import { cancelGoogleAuthCallback, receiveGoogleAuthCallback } from "./GoogleAuthCallback.ts";

async function freePort() {
  const server = NodeHttp.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function authorizationUrl(port: number, state = "s".repeat(43)) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: "1234-test.apps.googleusercontent.com",
    redirect_uri: `http://127.0.0.1:${port}`,
    response_type: "code",
    scope: "openid email",
    state,
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

function callback(request: string, params: Record<string, string> = { code: "test-code" }) {
  const url = new URL(request);
  return `${url.searchParams.get("redirect_uri")}/?${new URLSearchParams({
    state: url.searchParams.get("state")!,
    ...params,
  })}`;
}

describe("desktop Google callback helper", () => {
  it("binds before opening the browser, ignores foreign redirects, and returns the callback", async () => {
    const request = authorizationUrl(await freePort());
    const expected = callback(request);
    let opened = "";
    const received = await receiveGoogleAuthCallback(request, async (url) => {
      opened = url;
      const foreign = new URL(expected);
      foreign.searchParams.set("state", "x".repeat(43));
      expect((await fetch(foreign)).status).toBe(400);
      expect((await fetch(new URL("/favicon.ico", expected))).status).toBe(404);
      const response = await fetch(expected);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("test-code");
      return true;
    });
    expect(opened).toBe(request);
    expect(received).toBe(expected);
  });

  it("refuses to open anything but Google's authorize endpoint", async () => {
    const request = authorizationUrl(await freePort()).replace(
      "accounts.google.com",
      "accounts.evil.test",
    );
    await expect(receiveGoogleAuthCallback(request, async () => true)).rejects.toThrow(
      "Invalid Google sign-in request.",
    );
  });

  it("cancels and releases its port so the same sign-in can run again", async () => {
    const request = authorizationUrl(await freePort());
    const pending = receiveGoogleAuthCallback(request, async () => {
      cancelGoogleAuthCallback(request);
      return true;
    });
    await expect(pending).rejects.toThrow("cancelled");
    const received = await receiveGoogleAuthCallback(request, async () => {
      await fetch(callback(request, { error: "access_denied" }));
      return true;
    });
    expect(new URL(received).searchParams.get("error")).toBe("access_denied");
  });

  it("explains a port that is already taken on this computer", async () => {
    const port = await freePort();
    const blocker = NodeHttp.createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    try {
      let opened = false;
      await expect(
        receiveGoogleAuthCallback(authorizationUrl(port), async () => (opened = true)),
      ).rejects.toThrow("port is in use");
      expect(opened).toBe(false);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
