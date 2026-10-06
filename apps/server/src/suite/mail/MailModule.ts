/**
 * Otter Mail in Otterware: Mail's core (vendor/otter-mail) runs in a worker
 * thread on the server (`MailService.ts`), Mail's renderer in a frame on the
 * client (apps/web/src/suite/mail). Mail keeps its data in its own files
 * under `<stateDir>/mail`, so the module has no suite.sqlite tables.
 */
import { SUITE_MAIL_METHODS, SuiteMailRpcGroup } from "@t3tools/contracts/suite";
import * as Effect from "effect/Effect";

import { defineSuiteServerModule } from "../SuiteModule.ts";
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
  agentInstructions: `## Mail

The user's mail (Gmail and IMAP mailboxes, in Otterware's Mail) is yours through the \`mail_*\` tools: \`mail_list_accounts\`, \`mail_search_mail\`, \`mail_list_threads\`, \`mail_get_thread\`, \`mail_get_attachment\`, \`mail_update_threads\` (archive, label, mark read), \`mail_save_draft\`, \`mail_send_email\` and the rest. Use them for anything about the user's mail rather than a mail CLI. Calendar events belong to the Calendar module's tools.
Mail projects gather the conversations, documents, links and notes of one piece of work (\`mail_list_projects\`, \`mail_create_project\`, \`mail_add_to_project\`, \`mail_update_project\`); views are saved label filters across mailboxes (\`mail_list_views\`, \`mail_save_view\`).
Prepare mail with \`mail_save_draft\` unless the user asked you to send it. Never send an email, or delete mail for good, unless the user explicitly asks for it in this conversation. Threads without full access can only make changes that can be undone.`,
  homeContributor,
});
