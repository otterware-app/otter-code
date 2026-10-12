/**
 * Mail's part of Home: conversations from people that look like they need an
 * answer, and drafts waiting to be sent (`worker/home.ts`). Opening one goes
 * to `/mail?at=<Mail's route>`; replies can be archived from Home.
 */
import { SuiteHomeActionError, type SuiteHomeItem } from "@t3tools/contracts/suite";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { SuiteHomeContributor } from "../SuiteModule.ts";
import { MailService } from "./MailService.ts";
import type { MailHomeEntry } from "./worker/protocol.ts";

export const MAIL_HOME_ARCHIVE_ACTION = "archive";

export const toHomeItem = (entry: MailHomeEntry): SuiteHomeItem => ({
  id: entry.id,
  module: "mail",
  kind: entry.kind === "draft" ? "mail.draft" : "mail.reply",
  title: entry.title,
  subtitle: entry.subtitle,
  occurredAt: DateTime.formatIso(DateTime.makeUnsafe(entry.occurredAt)),
  priority: entry.priority,
  actions:
    entry.kind === "reply"
      ? [
          { id: "open", label: "Open", primary: true },
          { id: MAIL_HOME_ARCHIVE_ACTION, label: "Archive" },
        ]
      : [{ id: "open", label: "Open", primary: true }],
  target: { route: "/mail", params: { at: entry.at } },
});

export const homeContributor = Effect.gen(function* () {
  const mail = yield* MailService;
  return {
    module: "mail",
    needsYou: mail.needsYou.pipe(
      Effect.map((entries) => entries.map(toHomeItem)),
      Effect.catch((error) =>
        Effect.logWarning("Mail could not list what needs you", { cause: error.message }).pipe(
          Effect.as([]),
        ),
      ),
    ),
    performAction: (itemId, actionId) =>
      mail
        .homeAction(itemId, actionId)
        .pipe(
          Effect.mapError(
            (cause) => new SuiteHomeActionError({ module: "mail", itemId, actionId, cause }),
          ),
        ),
  } satisfies SuiteHomeContributor;
});
