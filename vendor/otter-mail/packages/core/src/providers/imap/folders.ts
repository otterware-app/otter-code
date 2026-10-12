/**
 * Folders as labels (docs/imap.md): INBOX and the special-use folders are
 * Gmail's system labels (\Sent → SENT, \Drafts → DRAFT, \Trash → TRASH,
 * \Junk → SPAM); the archive is no label at all (archived mail just lacks
 * INBOX); every other folder is a user label whose id is its path. Servers
 * that don't flag their special folders get them by name.
 *
 * Message ids are `<uidvalidity>:<uid>:<path>`: a message moved to another
 * folder gets a new id.
 */

import type { ImapClient, ImapFolder, SpecialUse } from "../../protocols/index.js";

export type Role = "INBOX" | "SENT" | "DRAFT" | "TRASH" | "SPAM" | "ARCHIVE";

export interface Folder {
  path: string;
  delimiter: string | null;
  role: Role | null;
  /** The label its mail carries: a system label, the path itself, or none (the archive). */
  labelId: string | null;
  /** The label's name: the path with "/" between levels. */
  name: string;
}

const SPECIAL_USE_ROLES: Partial<Record<SpecialUse, Role>> = {
  "\\Sent": "SENT",
  "\\Drafts": "DRAFT",
  "\\Trash": "TRASH",
  "\\Junk": "SPAM",
  "\\Archive": "ARCHIVE",
};

/** Folder names servers use for the special folders when they don't flag them. */
const ROLE_NAMES: Record<Exclude<Role, "INBOX">, string[]> = {
  SENT: [
    "sent",
    "sent items",
    "sent messages",
    "sent mail",
    "gesendet",
    "gesendete elemente",
    "envoyés",
    "éléments envoyés",
    "enviados",
    "posta inviata",
    "inviata",
    "verzonden",
  ],
  DRAFT: ["drafts", "draft", "entwürfe", "brouillons", "borradores", "bozze", "concepten"],
  TRASH: [
    "trash",
    "deleted items",
    "deleted messages",
    "bin",
    "papierkorb",
    "corbeille",
    "papelera",
    "cestino",
    "prullenbak",
  ],
  SPAM: ["junk", "spam", "junk e-mail", "junk email", "bulk mail", "courrier indésirable"],
  ARCHIVE: ["archive", "archives", "archiv", "archivo", "archivio", "archief"],
};

const SYSTEM_LABELS: Record<Exclude<Role, "ARCHIVE">, string> = {
  INBOX: "INBOX",
  SENT: "SENT",
  DRAFT: "DRAFT",
  TRASH: "TRASH",
  SPAM: "SPAM",
};

/** The labels flags stand for, besides the folder's own. */
export const FLAG_LABELS = ["UNREAD", "STARRED", "DRAFT"];

export class Folders {
  /** Selectable folders worth syncing, INBOX first, then Sent, the rest, Junk and Trash last. */
  readonly synced: Folder[];
  private readonly byPath = new Map<string, Folder>();

  constructor(list: ImapFolder[]) {
    const usable = list.filter(
      (f) => f.selectable && f.specialUse !== "\\All" && f.specialUse !== "\\Flagged",
    );
    const roles = new Map<Role, string>([["INBOX", "INBOX"]]);
    for (const f of usable) {
      const role = f.specialUse ? SPECIAL_USE_ROLES[f.specialUse] : undefined;
      if (role && !roles.has(role)) roles.set(role, f.path);
    }
    // By name, for the roles no folder is flagged with: top level, or right under INBOX.
    for (const [role, names] of Object.entries(ROLE_NAMES) as [Role, string[]][]) {
      if (roles.has(role)) continue;
      const match = usable.find((f) => {
        const parent = f.delimiter ? f.path.slice(0, -f.name.length - f.delimiter.length) : "";
        return (parent === "" || parent === "INBOX") && names.includes(f.name.toLowerCase());
      });
      if (match && ![...roles.values()].includes(match.path)) roles.set(role, match.path);
    }
    const roleOf = new Map([...roles].map(([role, path]) => [path, role]));
    for (const f of usable) {
      const role = roleOf.get(f.path) ?? null;
      this.byPath.set(f.path, {
        path: f.path,
        delimiter: f.delimiter,
        role,
        labelId: role === "ARCHIVE" ? null : role ? SYSTEM_LABELS[role] : f.path,
        name: labelName(f.path, f.delimiter),
      });
    }
    const ORDER: Partial<Record<Role, number>> = { INBOX: 0, SENT: 1, DRAFT: 2, SPAM: 4, TRASH: 5 };
    const order = (f: Folder) => (f.role && ORDER[f.role]) ?? 3;
    this.synced = [...this.byPath.values()].sort((a, b) => order(a) - order(b));
  }

  get(path: string): Folder | undefined {
    return this.byPath.get(path);
  }

  withRole(role: Role): Folder | undefined {
    return this.synced.find((f) => f.role === role);
  }

  /** The folder behind a label id (a system label's special folder, or a path). */
  forLabel(labelId: string): Folder | undefined {
    const byRole = (Object.keys(SYSTEM_LABELS) as (keyof typeof SYSTEM_LABELS)[]).find(
      (r) => SYSTEM_LABELS[r] === labelId,
    );
    return byRole ? this.withRole(byRole) : this.byPath.get(labelId);
  }

  /** Where a new folder named "A/B" goes: with the server's separator, under INBOX where all others are. */
  pathFor(name: string): string {
    const sample = this.synced.find((f) => f.delimiter);
    const delimiter = sample?.delimiter ?? "/";
    const underInbox =
      delimiter === "." &&
      this.synced.some((f) => f.role !== "INBOX" && f.path.startsWith("INBOX."));
    return (underInbox ? "INBOX." : "") + name.split("/").join(delimiter);
  }
}

function labelName(path: string, delimiter: string | null): string {
  let name = path;
  // Courier-style servers keep every folder under INBOX ("INBOX.Receipts").
  if (delimiter && path.toUpperCase().startsWith(`INBOX${delimiter}`)) {
    name = path.slice(6);
  }
  return delimiter && delimiter !== "/" ? name.split(delimiter).join("/") : name;
}

const folderCache = new Map<string, Folders>();

/** The account's folders: as last listed, or listed now. */
export async function foldersOf(accountId: string, client: ImapClient): Promise<Folders> {
  const cached = folderCache.get(accountId);
  if (cached) return cached;
  return listFolders(accountId, client);
}

export async function listFolders(accountId: string, client: ImapClient): Promise<Folders> {
  const folders = new Folders(await client.list());
  folderCache.set(accountId, folders);
  return folders;
}

export function forgetFolders(accountId: string): void {
  folderCache.delete(accountId);
}

/** A special folder, created ("Archive", "Trash", …) when the server has none. */
export async function ensureFolder(
  accountId: string,
  client: ImapClient,
  role: Exclude<Role, "INBOX">,
  name: string,
): Promise<Folder> {
  let folders = await foldersOf(accountId, client);
  let folder = folders.withRole(role);
  if (folder) return folder;
  folders = await listFolders(accountId, client);
  folder = folders.withRole(role);
  if (folder) return folder;
  await client.createMailbox(folders.pathFor(name));
  folder = (await listFolders(accountId, client)).withRole(role);
  if (!folder) throw new Error(`Couldn't create a ${name} folder.`);
  return folder;
}

// ── Message ids ─────────────────────────────────────────────────────────────

export type MessageRef = { uidValidity: number; uid: number; path: string };

export const messageId = (uidValidity: number, uid: number, path: string): string =>
  `${uidValidity}:${uid}:${path}`;

export function parseMessageId(id: string): MessageRef {
  const match = /^(\d+):(\d+):(.+)$/s.exec(id);
  if (!match) throw new Error(`Not an IMAP message id: ${id}`);
  return { uidValidity: Number(match[1]), uid: Number(match[2]), path: match[3]! };
}

/** Ids by folder, in the order given. */
export function byFolder(ids: string[]): Map<string, MessageRef[]> {
  const groups = new Map<string, MessageRef[]>();
  for (const id of ids) {
    const ref = parseMessageId(id);
    const group = groups.get(ref.path);
    if (group) group.push(ref);
    else groups.set(ref.path, [ref]);
  }
  return groups;
}

/** The labels a message in `folder` with these flags carries in the Gmail-shaped cache. */
export function labelsFor(folder: Folder | undefined, flags: string[]): string[] {
  const labels = folder?.labelId ? [folder.labelId] : [];
  const has = new Set(flags.map((f) => f.toLowerCase()));
  if (!has.has("\\seen")) labels.push("UNREAD");
  if (has.has("\\flagged")) labels.push("STARRED");
  if (has.has("\\draft") && !labels.includes("DRAFT")) labels.push("DRAFT");
  return labels;
}
