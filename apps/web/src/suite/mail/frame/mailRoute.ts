/**
 * Reads Mail's routes (its router.tsx): `/<mailbox>/<label>/<messageId>` with
 * `?account=` when the conversation lives in another mailbox than the one
 * shown (the combined mailbox, views, searches). Mailboxes are account ids
 * (addresses), or `all`, `projects` and view ids.
 */
export interface MailConversationRef {
  readonly accountId: string;
  readonly messageId: string;
}

export function mailConversationFromPath(path: string): MailConversationRef | null {
  const [pathname = "", search = ""] = path.split("?", 2);
  const segments = mailPathSegments(pathname);
  if (segments === null) return null;
  if (segments.length !== 3 || segments[0] === "settings") return null;
  const [mailbox, , messageId] = segments as [string, string, string];
  const params = new URLSearchParams(search);
  const accountId = params.get("account") ?? (mailbox.includes("@") ? mailbox : null);
  if (accountId === null) return null;
  return { accountId, messageId: params.get("message") ?? messageId };
}

/** Malformed deep links must not stop the frame or its context publisher. */
export function mailPathSegments(path: string): string[] | null {
  try {
    return path.split("?", 1)[0]!.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
}
