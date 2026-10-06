/**
 * Spaces: what the rail holds, and what the window shows one of at a time
 * (ChatGPT's). Each is named by an id, the route's first segment:
 *
 * - a mailbox: an account (its id), or all of them (COMBINED_ACCOUNT_ID);
 *   its sidebar has its folders and labels;
 * - a view (a custom view's id, `v_…`): its list alone, no sidebar;
 * - Projects (PROJECTS_SPACE): its sidebar lists them.
 */

import { COMBINED_ACCOUNT_ID, INBOX_VIEW_ID } from "./custom-views";
import { ALL_PROJECTS } from "./projects";
import type { GmailAccount, MailView } from "./types";

export const PROJECTS_SPACE = "__projects__";

/** A view's one "label": its list. */
export const VIEW_LIST = "all";

/** Views' ids (views-store's `v_…`), never an account's address. */
export const isViewSpaceId = (id: string) => id.startsWith("v_");

export type Space =
  | { kind: "mailbox"; id: string; account: GmailAccount }
  | { kind: "combined"; id: typeof COMBINED_ACCOUNT_ID }
  | { kind: "view"; id: string; view: MailView }
  | { kind: "projects"; id: typeof PROJECTS_SPACE };

/**
 * The space `id` names, among those there are: null for an account that's
 * gone (or turned off), All mailboxes while it's off, or a deleted view.
 */
export function spaceOf(
  id: string,
  { accounts, views, combined }: { accounts: GmailAccount[]; views: MailView[]; combined: boolean },
): Space | null {
  if (id === PROJECTS_SPACE) return { kind: "projects", id };
  if (id === COMBINED_ACCOUNT_ID) return combined ? { kind: "combined", id } : null;
  if (isViewSpaceId(id)) {
    const view = views.find((v) => v.kind === "custom" && v.id === id);
    return view ? { kind: "view", id, view } : null;
  }
  const account = accounts.find((a) => a.id === id);
  return account ? { kind: "mailbox", id, account } : null;
}

/** Where a space opens: its Inbox, its list, or every project's conversations. */
export function firstLabelOf(spaceId: string): string {
  if (spaceId === COMBINED_ACCOUNT_ID) return INBOX_VIEW_ID;
  if (spaceId === PROJECTS_SPACE) return ALL_PROJECTS;
  if (isViewSpaceId(spaceId)) return VIEW_LIST;
  return "INBOX";
}

/** Its list draws on every mailbox (or some), not one account's. */
export const spansMailboxes = (space: Space | null) => space != null && space.kind !== "mailbox";
