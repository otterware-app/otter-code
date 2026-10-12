// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Runs in Mail's worker, outside Effect.
/**
 * Keep Mail's vendored PKCE, token exchange and storage. Only its browser handoff changes:
 * the client captures Google's loopback URL and replies over suite.mail.reply. Validate it
 * against this flow before delivering it to Mail's still-pending listener on the server.
 */
import * as NodeAsyncHooks from "node:async_hooks";
import { googleCallbackUrl } from "@t3tools/shared/googleAuthCallback";
import { mailGoogleAuthorizationRequest } from "@t3tools/shared/suite/mailGoogleAuth";

import { requestClient } from "./workerLink.ts";

const signInContext = new NodeAsyncHooks.AsyncLocalStorage<AbortSignal>();

/** Cancellation, timeout and local completion also dismiss any remote browser handoff. */
export async function runGoogleSignIn<T>(run: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  try {
    return await signInContext.run(controller.signal, run);
  } finally {
    controller.abort();
  }
}

export async function receiveRemoteGoogleCallback(authorizationUrl: string): Promise<void> {
  const signal = signInContext.getStore();
  if (!signal) throw new Error("No Google sign-in is pending.");
  const flow = mailGoogleAuthorizationRequest(authorizationUrl);
  const result = await requestClient<unknown>(
    "googleAuth",
    { authorizationUrl: flow.authorizationUrl },
    signal,
  );
  if (signal.aborted) throw new Error("Google sign-in ended.");
  if (typeof result !== "string") throw new Error("Expected the Google callback URL.");
  const callback = googleCallbackUrl(result, flow.redirectUri, flow.state);
  try {
    const response = await fetch(callback, { signal, redirect: "error" });
    await response.body?.cancel();
    // A declined consent returns 400; Mail's listener rejects the original sign-in itself.
    if (response.status !== 200 && response.status !== 400)
      throw new Error("Google sign-in is no longer waiting for a callback.");
  } catch {
    // Never expose a callback URL (and its authorization code) in worker errors or logs.
    throw new Error("Could not complete Google sign-in on the server. Try again.");
  }
}
