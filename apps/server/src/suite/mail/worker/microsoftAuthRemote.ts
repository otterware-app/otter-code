// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Runs in Mail's worker, outside Effect.
import * as NodeAsyncHooks from "node:async_hooks";
import {
  mailMicrosoftAuthorizationRequest,
  mailMicrosoftCallbackUrl,
} from "@t3tools/shared/suite/mailMicrosoftAuth";

import { requestClient } from "./workerLink.ts";

const signInContext = new NodeAsyncHooks.AsyncLocalStorage<AbortSignal>();

export async function runMicrosoftSignIn<T>(run: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  try {
    return await signInContext.run(controller.signal, run);
  } finally {
    controller.abort();
  }
}

/** Forward only this pending flow's callback; Mail still exchanges and seals its tokens. */
export async function receiveRemoteMicrosoftCallback(authorizationUrl: string): Promise<void> {
  const signal = signInContext.getStore();
  if (!signal) throw new Error("No Microsoft sign-in is pending.");
  const flow = mailMicrosoftAuthorizationRequest(authorizationUrl);
  const result = await requestClient<unknown>(
    "microsoftAuth",
    { authorizationUrl: flow.authorizationUrl },
    signal,
  );
  if (signal.aborted) throw new Error("Microsoft sign-in ended.");
  if (typeof result !== "string") throw new Error("Expected the Microsoft callback URL.");
  const callback = mailMicrosoftCallbackUrl(result, flow.redirectUri, flow.state);
  // Mail binds IPv4 while Microsoft's registered redirect must say localhost.
  callback.hostname = "127.0.0.1";
  try {
    const response = await fetch(callback, { signal, redirect: "error" });
    await response.body?.cancel();
    if (response.status !== 200 && response.status !== 400)
      throw new Error("Microsoft sign-in is no longer waiting for a callback.");
  } catch {
    throw new Error("Could not complete Microsoft sign-in on the server. Try again.");
  }
}
