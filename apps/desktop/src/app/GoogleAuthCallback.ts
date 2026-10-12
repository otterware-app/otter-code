// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Native loopback helper uses a bounded Node listener with AbortController cleanup.
/**
 * Catches Google's loopback redirect on this computer for a sign-in that a remote environment
 * runs: Google sends the browser to `127.0.0.1` of the machine the browser is on, which is this
 * one, not the environment's. The renderer hands the caught URL to the environment
 * (`calendar.google.connectComplete`), which owns the PKCE verifier and the token exchange.
 */
import * as NodeHttp from "node:http";
import {
  googleAuthorizationRequest,
  handleGoogleCallbackRequest,
} from "@t3tools/shared/googleAuthCallback";
import { BRAND } from "@t3tools/shared/brand";
import * as Schema from "effect/Schema";

export class GoogleAuthCallbackError extends Schema.TaggedError<GoogleAuthCallbackError>()(
  "GoogleAuthCallbackError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

const TIMEOUT_MS = 5 * 60_000;
const listeners = new Map<string, AbortController>();

export function cancelGoogleAuthCallback(authorizationUrl: string) {
  const { state } = googleAuthorizationRequest(authorizationUrl);
  listeners.get(state)?.abort();
}

/**
 * Binds the flow's loopback port, opens the sign-in in the system browser and resolves with
 * the redirect URL. Rejects with a readable message when the port is taken (for example when
 * the environment runs on this computer and listens itself), on timeout, or on cancel.
 */
export async function receiveGoogleAuthCallback(
  authorizationUrl: string,
  openBrowser: (url: string) => Promise<boolean>,
  signal?: AbortSignal,
) {
  const request = googleAuthorizationRequest(authorizationUrl);
  if (listeners.has(request.state))
    throw new Error("This Google sign-in is already open on this computer.");
  const abort = new AbortController();
  const interrupted = () => abort.abort();
  signal?.addEventListener("abort", interrupted, { once: true });
  listeners.set(request.state, abort);
  const callback = Promise.withResolvers<string>();
  // Keep early open/bind failures from leaving an unobserved rejection behind.
  void callback.promise.catch(() => undefined);
  let received = false;
  const server = NodeHttp.createServer((incoming, response) => {
    if (received) {
      response.writeHead(410).end("This sign-in is no longer active.");
      return;
    }
    const url = handleGoogleCallbackRequest(incoming, response, request.redirectUri, request.state);
    if (!url) return;
    received = true;
    callback.resolve(url.toString());
  });
  const cancelled = () =>
    callback.reject(new Error("Google sign-in was cancelled on this computer."));
  abort.signal.addEventListener("abort", cancelled, { once: true });
  const timer = setTimeout(
    () => callback.reject(new Error("Google sign-in timed out. Start again.")),
    TIMEOUT_MS,
  );
  timer.unref();
  try {
    if (signal?.aborted) throw new Error("Google sign-in was cancelled on this computer.");
    await new Promise<void>((resolve, reject) => {
      server.once("error", () =>
        reject(
          new Error(
            `The Google sign-in port is in use on this computer. Open the sign-in link yourself, or paste the address the browser lands on in ${BRAND.displayName}.`,
          ),
        ),
      );
      server.listen(Number(new URL(request.redirectUri).port), "127.0.0.1", resolve);
    });
    if (abort.signal.aborted) throw new Error("Google sign-in was cancelled on this computer.");
    if (!(await openBrowser(request.authorizationUrl)))
      throw new Error("Could not open your browser for the Google sign-in.");
    return await callback.promise;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", interrupted);
    abort.signal.removeEventListener("abort", cancelled);
    listeners.delete(request.state);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
