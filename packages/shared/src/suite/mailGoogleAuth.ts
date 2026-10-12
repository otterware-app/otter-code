/** Compatibility at Mail's adapter boundary; both Mail and Calendar vendors stay verbatim. */
import { googleAuthorizationRequest } from "../googleAuthCallback.ts";

export function mailGoogleAuthorizationRequest(authorizationUrl: string) {
  if (authorizationUrl.length > 16_384 || !URL.canParse(authorizationUrl))
    throw new Error("Invalid Google sign-in request.");
  const browserUrl = new URL(authorizationUrl);
  const states = browserUrl.searchParams.getAll("state");
  const state = states[0];
  if (states.length !== 1 || !state || !/^[\w-]{22,128}$/u.test(state))
    throw new Error("Invalid Google sign-in request.");
  // Mail uses a 16-byte nonce; Calendar's native helper requires at least 32 characters.
  // Prefix only the native handoff's nonce, then translate its validated response back.
  // Ordinary browser links keep the original nonce so the local Mail listener also works.
  browserUrl.searchParams.set("state", state.length < 32 ? `otter_mail_${state}` : state);
  const native = googleAuthorizationRequest(browserUrl.toString());
  return {
    authorizationUrl: new URL(authorizationUrl).toString(),
    redirectUri: native.redirectUri,
    state,
    nativeAuthorizationUrl: native.authorizationUrl,
    nativeState: native.state,
  };
}
