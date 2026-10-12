import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  cancelGoogleAuthCallback,
  GoogleAuthCallbackError,
  receiveGoogleAuthCallback as receiveCallback,
} from "../../app/GoogleAuthCallback.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

const AuthorizationUrl = Schema.String.check(Schema.isMaxLength(16_384));

/** Catches Google's loopback redirect here for a sign-in owned by a remote environment. */
export const receiveGoogleAuthCallback = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECEIVE_GOOGLE_AUTH_CALLBACK_CHANNEL,
  payload: AuthorizationUrl,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.googleAuth.receive")(function* (authorizationUrl) {
    const shell = yield* ElectronShell.ElectronShell;
    const windows = yield* ElectronWindow.ElectronWindow;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<ElectronShell.ElectronShell>());
    const callbackUrl = yield* Effect.tryPromise({
      try: () => receiveCallback(authorizationUrl, (url) => runPromise(shell.openExternal(url))),
      // The helper's messages are written for the user and never contain the code.
      catch: (cause) =>
        new GoogleAuthCallbackError({
          detail:
            cause instanceof Error
              ? cause.message
              : "Could not receive the Google sign-in on this computer.",
        }),
    });
    const window = yield* windows.currentMainOrFirst;
    if (Option.isSome(window)) yield* windows.reveal(window.value);
    return callbackUrl;
  }),
});

export const cancelGoogleAuthCallbackMethod = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CANCEL_GOOGLE_AUTH_CALLBACK_CHANNEL,
  payload: AuthorizationUrl,
  result: Schema.Void,
  handler: (authorizationUrl) =>
    Effect.try({
      try: () => cancelGoogleAuthCallback(authorizationUrl),
      catch: () => new GoogleAuthCallbackError({ detail: "Invalid Google sign-in request." }),
    }),
});
