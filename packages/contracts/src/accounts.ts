import * as Schema from "effect/Schema";

export const OtterAccountUser = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  image: Schema.NullOr(Schema.String),
});
export type OtterAccountUser = typeof OtterAccountUser.Type;

export const OtterAccountSession = Schema.Struct({
  version: Schema.Literal(1),
  accountsUrl: Schema.String,
  resource: Schema.String,
  clientId: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  user: OtterAccountUser,
});
export type OtterAccountSession = typeof OtterAccountSession.Type;
