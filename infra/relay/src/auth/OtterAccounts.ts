import { OtterAccountUser } from "@t3tools/contracts/accounts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as RelayConfiguration from "../Config.ts";

export class AccountTokenVerificationFailed extends Schema.TaggedError<AccountTokenVerificationFailed>()(
  "AccountTokenVerificationFailed",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Otter account token verification failed.";
  }
}

export class OtterAccounts extends Context.Service<
  OtterAccounts,
  {
    readonly verify: (
      token: string,
    ) => Effect.Effect<OtterAccountUser, AccountTokenVerificationFailed>;
  }
>()("t3code-relay/auth/OtterAccounts") {}

const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  return OtterAccounts.of({
    // Accounts checks signature, audience, owning client and the current session.
    // Online verification makes revocations effective without a replicated identity database.
    verify: Effect.fn("relay.accounts.verify")(function* (token: string) {
      return yield* client
        .execute(
          HttpClientRequest.get(`${config.accountsUrl.replace(/\/$/, "")}/code/session`).pipe(
            HttpClientRequest.bearerToken(token),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(OtterAccountUser)),
          Effect.timeout("10 seconds"),
          Effect.mapError((cause) => new AccountTokenVerificationFailed({ cause })),
        );
    }),
  });
});

export const layer = Layer.effect(OtterAccounts, make);
