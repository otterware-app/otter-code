/**
 * Otter Mail in Otterware: Mail's core (vendor/otter-mail) runs in a worker
 * thread on the server (`MailService.ts`), Mail's renderer in a frame on the
 * client (apps/web/src/suite/mail). Mail keeps its data in its own files
 * under `<stateDir>/mail`, so the module has no suite.sqlite tables.
 */
import { SUITE_MAIL_METHODS, SuiteMailRpcGroup } from "@t3tools/contracts/suite";
import * as Effect from "effect/Effect";

import { defineSuiteServerModule } from "../SuiteModule.ts";
import { MAIL_INSTRUCTIONS } from "./mailInstructions.ts";
import { homeContributor } from "./MailHome.ts";
import * as MailService from "./MailService.ts";
import * as MailToolkit from "./MailToolkit.ts";

const rpcHandlers = SuiteMailRpcGroup.toLayer(
  Effect.gen(function* () {
    const mail = yield* MailService.MailService;
    return SuiteMailRpcGroup.of({
      [SUITE_MAIL_METHODS.invoke]: (input) => mail.invoke(input),
      [SUITE_MAIL_METHODS.events]: ({ clientId }) => mail.events(clientId),
      [SUITE_MAIL_METHODS.reply]: (input) => mail.reply(input),
    });
  }),
);

export const MailModule = defineSuiteServerModule({
  id: "mail",
  migrations: [],
  layer: MailService.layer,
  rpcHandlers,
  mcpToolkit: MailToolkit.layer,
  agentInstructions: MAIL_INSTRUCTIONS,
  homeContributor,
});
