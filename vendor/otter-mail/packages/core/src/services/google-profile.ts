/**
 * Google's name and picture for a Gmail account change (a new photo, a new
 * name), so they're read again rather than kept from sign-in. The relay
 * carries them to the other devices (linked-accounts.ts).
 */

import { broadcast } from "../ipc.js";
import { logger } from "../logger.js";
import { platform } from "../platform.js";
import { isSignedIn } from "../providers/index.js";
import { listAccounts, updateAccount } from "./account-store.js";
import { accountEdited } from "./linked-accounts.js";
import type { GmailAccount } from "../types.js";

const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const FETCH_TIMEOUT_MS = 10_000;

async function refreshProfile(account: GmailAccount): Promise<boolean> {
  const token = await platform().google.getAccessToken(account.id);
  const response = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return false;
  const { name, picture } = (await response.json()) as { name?: string; picture?: string };
  // Nothing from Google never clears what's stored.
  const newName = name && name !== account.name ? name : undefined;
  const newPicture = picture && picture !== account.picture ? picture : undefined;
  if (!newName && !newPicture) return false;
  const updated = await updateAccount(account.id, { name: newName, picture: newPicture });
  void accountEdited(updated, ["name", "picture"]);
  return true;
}

/** Brings every signed-in Gmail account's name and picture up to date with Google. */
export async function refreshProfiles(): Promise<void> {
  let changed = false;
  for (const account of await listAccounts()) {
    if (account.provider === "imap" || !isSignedIn(account)) continue;
    try {
      changed = (await refreshProfile(account)) || changed;
    } catch (err) {
      logger.info("google-profile", `Couldn't read ${account.email}'s profile: ${String(err)}`);
    }
  }
  if (changed) broadcast("gmail:accounts-changed");
}
