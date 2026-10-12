// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- An isolated native callback listener, with the browser stubbed.
import * as NodeHttp from "node:http";
import { expect, it } from "vite-plus/test";
import { mailGoogleAuthorizationRequest } from "@t3tools/shared/suite/mailGoogleAuth";

import { receiveGoogleAuthCallback } from "../../app/GoogleAuthCallback.ts";

it("captures Mail's adapted nonce using Calendar's unmodified desktop helper", async () => {
  const probe = NodeHttp.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Missing port");
  const state = "m".repeat(22);
  const redirectUri = `http://127.0.0.1:${address.port}`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: "1234-test.apps.googleusercontent.com",
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
  }).toString();
  const flow = mailGoogleAuthorizationRequest(url.toString());
  const callback = `${redirectUri}/?${new URLSearchParams({ state: flow.nativeState, code: "test-code" })}`;
  const received = await receiveGoogleAuthCallback(flow.nativeAuthorizationUrl, async () => {
    // A response using the original nonce belongs to the server's listener, not this helper.
    expect((await fetch(callback.replace(flow.nativeState, state))).status).toBe(400);
    expect((await fetch(callback)).status).toBe(200);
    return true;
  });
  expect(received).toBe(callback);
});
