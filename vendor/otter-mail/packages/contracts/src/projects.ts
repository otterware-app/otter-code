/**
 * Projects: conversations, links and notes that belong together (a contract
 * spread over threads with different people, say) until the work is done
 * and the project is settled. They follow the Otter account to every device
 * through the relay (`/v1/projects`, below), and agents manage them with the
 * tools in project-tools.ts.
 *
 * A project's documents aren't stored: they are the attachments of its
 * conversations, gathered by each device from its mail, plus its links.
 */

export type ProjectStatus = "active" | "settled";

/** A conversation in a project: a mailbox (by address, lower-cased) and its thread. */
export interface ProjectThread {
  email: string;
  threadId: string;
  /** From this device's mail, empty where it doesn't have the conversation: the relay keeps no subjects. */
  subject: string;
  addedAt: number;
}

export interface ProjectLink {
  id: string;
  url: string;
  title: string;
  addedAt: number;
}

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  /** Plain text (Markdown): where things stand, kept current by you and your agent. */
  notes: string;
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
  threads: ProjectThread[];
  links: ProjectLink[];
}

/** One attachment of a project's conversations. */
export interface ProjectDocumentVersion {
  filename: string;
  mimeType: string;
  size: number;
  email: string;
  threadId: string;
  messageId: string;
  attachmentId: string;
  /** Who sent it. */
  from: string;
  date: number;
}

/** Attachments that are versions of one document (contract_v2.pdf, Contract v3 final.pdf…), newest first. */
export interface ProjectDocument {
  name: string;
  versions: ProjectDocumentVersion[];
}

/**
 * What versions of a document share: the name without version markers (v2,
 * rev 3, final, draft, (1), dates, copy numbers), case and separators.
 */
export function documentKey(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
  const stem = (dot > 0 ? filename.slice(0, dot) : filename).toLowerCase();
  const base = stem
    .replace(/(^|\D)\d{4}[-_.]?\d{2}[-_.]?\d{2}(?!\d)/g, "$1 ")
    .replace(/[\s._\-()[\]]+/g, " ")
    .replace(/\b(v|ver|version|rev|revision|r) ?\d+( \d+)*\b/g, " ")
    .replace(
      /\b(final|draft|clean|redline[ds]?|signed|executed|updated|copy|new|latest|\d)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return `${base || stem}.${ext}`;
}

/** Groups attachments by document, the most recently changed document first. */
export function groupDocuments(versions: ProjectDocumentVersion[]): ProjectDocument[] {
  const byKey = new Map<string, ProjectDocumentVersion[]>();
  for (const version of versions) {
    const key = documentKey(version.filename);
    byKey.set(key, [...(byKey.get(key) ?? []), version]);
  }
  return [...byKey.values()]
    .map((group) => {
      const sorted = group.sort((a, b) => b.date - a.date);
      return { name: sorted[0].filename, versions: sorted };
    })
    .sort((a, b) => b.versions[0].date - a.versions[0].date);
}

/** What the relay keeps of a project itself; threads and links are written on their own. */
export type ProjectFields = Pick<Project, "name" | "status" | "notes" | "createdAt" | "settledAt">;

export const PROJECT_LIMITS = {
  projects: 500,
  threads: 500,
  links: 200,
  name: 200,
  notes: 20_000,
  url: 2048,
  title: 300,
} as const;

/**
 * The relay's routes, signed in like the others (relay.ts). Each write is
 * its own row, so two devices (or an agent and you) changing different
 * parts of a project never undo each other; the relay then sends the
 * `projects` event.
 *
 * - `GET /v1/projects` → `ListProjectsResponse` (threads' subjects empty)
 * - `PUT /v1/projects/:id` with `ProjectFields`: creates or updates it.
 * - `DELETE /v1/projects/:id`, with its threads and links.
 * - `PUT /v1/projects/:id/threads/:email/:threadId` with `{ addedAt }`
 *   (path segments URI-encoded), `DELETE` the same.
 * - `PUT /v1/projects/:id/links/:linkId` with `{ url, title, addedAt }`,
 *   `DELETE` the same.
 *
 * Writing a thread or link of a project that doesn't exist is a 404; past
 * `PROJECT_LIMITS`, a 413.
 */
export interface ListProjectsResponse {
  projects: Project[];
}

export type PutProjectThreadRequest = Pick<ProjectThread, "addedAt">;
export type PutProjectLinkRequest = Pick<ProjectLink, "url" | "title" | "addedAt">;

/** `p_<time>_<random>`, like views' ids. */
export function newProjectId(prefix = "p"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
