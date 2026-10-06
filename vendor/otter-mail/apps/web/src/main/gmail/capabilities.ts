import { GMAIL_CAPABILITIES, type MailCapabilities } from "@otter-mail/contracts";
import { useAccounts } from "./hooks";
import type { GmailAccount } from "./types";

/**
 * What a mailbox can do (Gmail's categories, several labels per message, …).
 * The UI hides what a mailbox can't do from these, the way it gates Mac-only
 * UI on `features`, and never from the provider itself. Accounts listed
 * before capabilities existed are Gmail.
 */
export function capabilitiesOf(account: GmailAccount | null | undefined): MailCapabilities {
  return account?.capabilities ?? GMAIL_CAPABILITIES;
}

/** An account's capabilities, by id (Gmail's until the accounts load). */
export function useCapabilities(accountId: string | null | undefined): MailCapabilities {
  const accounts = useAccounts().data;
  return capabilitiesOf(accounts?.find((a) => a.id === accountId));
}

/** Signs in with a password on each device (IMAP) rather than with Google. */
export function signsInWithPassword(account: GmailAccount): boolean {
  return account.imap != null;
}

/** Where the account's mail lives, for copy like "Nothing is deleted from Gmail". */
export function mailServerName(account: GmailAccount): string {
  return account.imap ? account.imap.imap.host : "Gmail";
}
