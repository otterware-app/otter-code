import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopAccountSession from "../../app/DesktopAccountSession.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getAccountSession = DesktopIpc.makeIpcMethod({
  channel: "otter-account:get-session",
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: () =>
    Effect.gen(function* () {
      return yield* (yield* DesktopAccountSession.DesktopAccountSession).read;
    }),
});
export const setAccountSession = DesktopIpc.makeIpcMethod({
  channel: "otter-account:set-session",
  payload: Schema.NullOr(Schema.String),
  result: Schema.Void,
  handler: (value) =>
    Effect.gen(function* () {
      yield* (yield* DesktopAccountSession.DesktopAccountSession).write(value);
    }),
});
export const authorizeAccount = DesktopIpc.makeIpcMethod({
  channel: "otter-account:authorize",
  payload: Schema.Struct({
    state: Schema.String.check(
      Schema.isMinLength(32),
      Schema.isMaxLength(128),
      Schema.isPattern(/^[A-Za-z0-9_-]+$/),
    ),
    challenge: Schema.String.check(
      Schema.isMinLength(32),
      Schema.isMaxLength(128),
      Schema.isPattern(/^[A-Za-z0-9_-]+$/),
    ),
  }),
  result: Schema.Struct({ code: Schema.String, redirectUri: Schema.String }),
  handler: (request) =>
    Effect.gen(function* () {
      return yield* (yield* DesktopAccountSession.DesktopAccountSession).authorize(request);
    }),
});
