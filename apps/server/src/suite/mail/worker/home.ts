/**
 * Mail's part of Home's "needs you": recent unread conversations from people
 * in the inbox (not newsletters, notifications or Gmail's category tabs),
 * and drafts waiting to be sent. Read from Mail's local cache only, so Home
 * never triggers a sync or a Gmail request.
 */
import {
  accountStore,
  mailStore,
  type GmailAccount,
  type GmailMessageSummary,
} from "@otter-mail/core";

import type { MailHomeEntry } from "./protocol.ts";

const RECENT_MS = 14 * 24 * 60 * 60 * 1000;
const PAGE = 60;
const MAX_PER_ACCOUNT = 8;
const MAX_DRAFTS = 5;

/** Gmail's tabs other than Primary: mail that rarely needs an answer. */
const BULK_LABELS = new Set([
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
  "SPAM",
  "TRASH",
]);

const AUTOMATED_SENDER =
  /(^|[._+-])(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|newsletter|news|updates?|alerts?|billing|receipts?|support|team|info|hello|marketing)([._+-]|@)/i;

/** Whether a message looks like it came from a person, not a system. */
export function looksPersonal(message: GmailMessageSummary, account: GmailAccount): boolean {
  const from = message.fromEmail.toLowerCase();
  if (from.length === 0 || from === account.email.toLowerCase()) return false;
  if (AUTOMATED_SENDER.test(from)) return false;
  const labels = message.threadLabelIds ?? message.labelIds;
  return !labels.some((label) => BULK_LABELS.has(label));
}

/** Mail's hash route for a conversation (its router: `$mailbox/$label/$messageId`). */
export const conversationPath = (accountId: string, labelId: string, messageId: string) =>
  `/${[accountId, labelId, messageId].map((part) => encodeURIComponent(part).replaceAll("%40", "@")).join("/")}`;

const sender = (message: GmailMessageSummary) => message.fromName || message.fromEmail;

export async function mailNeedsYou(now: number): Promise<ReadonlyArray<MailHomeEntry>> {
  const accounts = await accountStore.listAccounts();
  const entries: MailHomeEntry[] = [];
  for (const account of accounts) {
    const inbox = mailStore.getThreadsPage(account.id, "INBOX", 0, PAGE).messages;
    const replies = inbox
      .filter(
        (message) =>
          (message.threadUnread ?? message.unread) &&
          now - message.date < RECENT_MS &&
          looksPersonal(message, account),
      )
      .slice(0, MAX_PER_ACCOUNT);
    for (const message of replies) {
      const ageHours = (now - message.date) / 3_600_000;
      entries.push({
        id: `reply:${account.id}:${message.threadId}`,
        kind: "reply",
        title: message.subject || "(no subject)",
        subtitle: `${sender(message)}${accounts.length > 1 ? ` · ${account.email}` : ""}`,
        occurredAt: message.date,
        // Starred and fresh mail first; a week old sinks below new arrivals.
        priority:
          60 + (message.threadStarred || message.starred ? 15 : 0) - Math.min(ageHours / 12, 30),
        at: conversationPath(account.id, "INBOX", message.id),
        accountId: account.id,
        threadId: message.threadId,
        sender: { name: message.fromName, email: message.fromEmail },
        labelIds: message.threadLabelIds ?? message.labelIds,
      });
    }
    const drafts = mailStore.getThreadsPage(account.id, "DRAFT", 0, MAX_DRAFTS).messages;
    for (const draft of drafts) {
      if (now - draft.date > RECENT_MS) continue;
      entries.push({
        id: `draft:${account.id}:${draft.threadId}`,
        kind: "draft",
        title: draft.subject || "(no subject)",
        subtitle: `Draft${draft.to ? ` to ${draft.to}` : ""}${accounts.length > 1 ? ` · ${account.email}` : ""}`,
        occurredAt: draft.date,
        priority: 40,
        at: conversationPath(account.id, "DRAFT", draft.id),
        accountId: account.id,
        threadId: draft.threadId,
        sender: { name: draft.fromName, email: draft.fromEmail },
        labelIds: draft.labelIds,
      });
    }
  }
  return entries.toSorted((a, b) => b.priority - a.priority || b.occurredAt - a.occurredAt);
}

/** `reply:<account>:<thread>` → its parts; accounts are addresses, so split from both ends. */
export function parseHomeItemId(
  itemId: string,
): { kind: string; accountId: string; threadId: string } | null {
  const first = itemId.indexOf(":");
  const last = itemId.lastIndexOf(":");
  if (first <= 0 || last <= first) return null;
  return {
    kind: itemId.slice(0, first),
    accountId: itemId.slice(first + 1, last),
    threadId: itemId.slice(last + 1),
  };
}
