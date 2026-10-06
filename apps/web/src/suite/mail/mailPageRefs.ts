import type { SuitePageRef } from "../suitePageContext";

/** Mailbox and label context stays useful even when no conversation is open. */
export function mailPageRefs(path: string): SuitePageRef[] {
  let parts: string[];
  try {
    parts = path.split("?", 1)[0]!.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return [];
  }
  const [mailbox, label] = parts;
  if (!mailbox || mailbox === "settings") return [];
  return [
    { kind: "mail.mailbox", id: mailbox, label: mailbox },
    ...(label ? [{ kind: "mail.label", id: label, label }] : []),
  ];
}
