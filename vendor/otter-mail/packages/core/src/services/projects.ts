/**
 * Projects (contracts' projects.ts), local-first: this device keeps them in
 * projects.json (with its conversations' subjects, which the relay doesn't keep) and changes them there at once, then writes each change to
 * the relay (the project's fields, one thread, one link) when signed in to
 * an Otter account. Changes not on the relay yet are `pending`, by key; a
 * pull (on connecting, and on the relay's `projects` event) takes the
 * account's projects and lays the pending changes over them. Without an
 * Otter account, projects stay on this device until one signs in.
 */

import type {
  ListProjectsResponse,
  Project,
  ProjectDocument,
  ProjectDocumentVersion,
  ProjectFields,
  ProjectLink,
  ProjectThread,
} from "@otter-mail/contracts/projects";
import { groupDocuments, newProjectId, PROJECT_LIMITS } from "@otter-mail/contracts/projects";
import type { ProjectBackend } from "@otter-mail/contracts/project-tools";

import { broadcast } from "../ipc.js";
import { readJson, writeJson } from "../json-file.js";
import { logger } from "../logger.js";
import { providerFor } from "../providers/index.js";
import { listAccounts } from "./account-store.js";
import * as mailStore from "./mail-store.js";
import { getOtterUser, relayRequest, RelayError } from "./otter-account.js";

const FILE = "projects.json";
export const PROJECTS_CHANGED = "projects:changed";

/** A change to write to the relay: a project's fields, one of its threads, or one of its links. */
type Key = ["p", string] | ["t", string, string, string] | ["l", string, string];

type ProjectsFile = { projects: Project[]; pending: string[] };

let state: ProjectsFile | null = null;
let writes: Promise<unknown> = Promise.resolve();

async function load(): Promise<ProjectsFile> {
  if (!state) {
    const saved = await readJson<ProjectsFile>(FILE);
    state = { projects: saved?.projects ?? [], pending: saved?.pending ?? [] };
  }
  return state;
}

/**
 * Runs `change` on the projects, one change at a time, and saves; `quiet`
 * when only what's pending changed, which the windows don't show.
 */
function mutate<T>(change: (file: ProjectsFile) => T | Promise<T>, quiet = false): Promise<T> {
  const run = writes.then(async () => {
    const file = await load();
    const result = await change(file);
    await writeJson(FILE, file);
    if (!quiet) broadcast(PROJECTS_CHANGED);
    return result;
  });
  writes = run.catch(() => {});
  return run;
}

export async function listProjects(): Promise<Project[]> {
  await writes;
  return (await load()).projects;
}

function find(file: ProjectsFile, id: string): Project {
  const project = file.projects.find((p) => p.id === id);
  if (!project) throw new Error("No such project.");
  return project;
}

function queue(file: ProjectsFile, key: Key): void {
  const json = JSON.stringify(key);
  if (!file.pending.includes(json)) file.pending.push(json);
  schedulePush();
}

const touch = (project: Project) => {
  project.updatedAt = Date.now();
};

// ── Changes ─────────────────────────────────────────────────────────────────

export function createProject(input: { name: string; notes?: string }): Promise<Project> {
  return mutate((file) => {
    if (file.projects.length >= PROJECT_LIMITS.projects) throw new Error("Too many projects.");
    const now = Date.now();
    const project: Project = {
      id: newProjectId(),
      name: input.name.trim().slice(0, PROJECT_LIMITS.name) || "Untitled project",
      status: "active",
      notes: (input.notes ?? "").slice(0, PROJECT_LIMITS.notes),
      createdAt: now,
      updatedAt: now,
      settledAt: null,
      threads: [],
      links: [],
    };
    file.projects.unshift(project);
    queue(file, ["p", project.id]);
    return project;
  });
}

export function updateProject(
  id: string,
  patch: Partial<Pick<Project, "name" | "notes" | "status">>,
): Promise<Project> {
  return mutate((file) => {
    const project = find(file, id);
    if (patch.name !== undefined && patch.name.trim()) {
      project.name = patch.name.trim().slice(0, PROJECT_LIMITS.name);
    }
    if (patch.notes !== undefined) project.notes = patch.notes.slice(0, PROJECT_LIMITS.notes);
    if (patch.status && patch.status !== project.status) {
      project.status = patch.status;
      project.settledAt = patch.status === "settled" ? Date.now() : null;
    }
    touch(project);
    queue(file, ["p", id]);
    return project;
  });
}

export function deleteProject(id: string): Promise<void> {
  return mutate((file) => {
    file.projects = file.projects.filter((p) => p.id !== id);
    // The project's own delete takes its threads and links along.
    file.pending = file.pending.filter((json) => (JSON.parse(json) as Key)[1] !== id);
    queue(file, ["p", id]);
  });
}

/** The subject this device has for a conversation, if any. */
async function subjectOf(email: string, threadId: string): Promise<string> {
  const account = (await listAccounts()).find((a) => a.email.toLowerCase() === email);
  if (!account) return "";
  return mailStore.getThreadSummaries(account.id, [threadId])[0]?.subject ?? "";
}

export function addThreads(
  id: string,
  threads: { email: string; threadId: string; subject?: string }[],
): Promise<Project> {
  return mutate(async (file) => {
    const project = find(file, id);
    for (const t of threads) {
      const email = t.email.trim().toLowerCase();
      if (project.threads.some((p) => p.email === email && p.threadId === t.threadId)) continue;
      if (project.threads.length >= PROJECT_LIMITS.threads) throw new Error("The project is full.");
      project.threads.push({
        email,
        threadId: t.threadId,
        subject: (t.subject || (await subjectOf(email, t.threadId))).slice(0, 998),
        addedAt: Date.now(),
      });
      queue(file, ["t", id, email, t.threadId]);
    }
    touch(project);
    return project;
  });
}

export function removeThread(id: string, email: string, threadId: string): Promise<Project> {
  return mutate((file) => {
    const project = find(file, id);
    const address = email.toLowerCase();
    project.threads = project.threads.filter(
      (t) => !(t.email === address && t.threadId === threadId),
    );
    touch(project);
    queue(file, ["t", id, address, threadId]);
    return project;
  });
}

export function addLink(id: string, input: { url: string; title?: string }): Promise<ProjectLink> {
  return mutate((file) => {
    const project = find(file, id);
    const url = new URL(input.url.trim()).href;
    const existing = project.links.find((l) => l.url === url);
    if (existing) return existing;
    if (project.links.length >= PROJECT_LIMITS.links) throw new Error("The project is full.");
    const link: ProjectLink = {
      id: newProjectId("l"),
      url: url.slice(0, PROJECT_LIMITS.url),
      title: (input.title?.trim() || url).slice(0, PROJECT_LIMITS.title),
      addedAt: Date.now(),
    };
    project.links.push(link);
    touch(project);
    queue(file, ["l", id, link.id]);
    return link;
  });
}

export function removeLink(id: string, linkId: string): Promise<Project> {
  return mutate((file) => {
    const project = find(file, id);
    project.links = project.links.filter((l) => l.id !== linkId);
    touch(project);
    queue(file, ["l", id, linkId]);
    return project;
  });
}

// ── Documents ───────────────────────────────────────────────────────────────

/**
 * The attachments of the project's conversations, as documents with their
 * versions. Messages this device hasn't fetched in full yet are, first.
 */
export async function projectDocuments(project: Project): Promise<ProjectDocument[]> {
  const accounts = await listAccounts();
  const versions: ProjectDocumentVersion[] = [];
  for (const thread of project.threads) {
    const account = accounts.find((a) => a.email.toLowerCase() === thread.email);
    if (!account) continue;
    // Not `hasAttachments`: list fetches don't know it, only a message's details do.
    for (const message of mailStore.getThreadMessages(account.id, thread.threadId)) {
      let detail = mailStore.getMessageDetail(account.id, message.id);
      if (!detail) {
        try {
          detail = await providerFor(account.id).getMessage(account.id, message.id);
          mailStore.upsertMessageDetail(account.id, detail);
        } catch (err) {
          logger.info("projects", `Couldn't fetch a message's attachments: ${String(err)}`);
          continue;
        }
      }
      for (const attachment of detail.attachments) {
        versions.push({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.size,
          email: thread.email,
          threadId: thread.threadId,
          messageId: message.id,
          attachmentId: attachment.id,
          from: message.fromName || message.fromEmail,
          date: message.date,
        });
      }
    }
  }
  return groupDocuments(versions);
}

/** The project tools' store: this device's projects. */
export const localBackend: ProjectBackend = {
  list: listProjects,
  create: createProject,
  update: updateProject,
  addThread: async (id, thread) => void (await addThreads(id, [thread])),
  removeThread: async (id, email, threadId) => void (await removeThread(id, email, threadId)),
  addLink,
  removeLink: async (id, linkId) => void (await removeLink(id, linkId)),
  documents: projectDocuments,
};

// ── Sync ────────────────────────────────────────────────────────────────────

const RETRY_MS = 30_000;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
/** When the scheduled push runs. */
let pushAt = 0;
let pushing: Promise<void> | null = null;
/** The change being written now: still this device's until the relay has it. */
let inFlight: string | null = null;

/** Pushes in `delay` ms, or sooner if a push is scheduled sooner (a retry waits longer than a change). */
function schedulePush(delay = 300): void {
  if (!getOtterUser()) return;
  if (pushTimer && pushAt <= Date.now() + delay) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushAt = Date.now() + delay;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void push();
  }, delay);
}

const segment = encodeURIComponent;

/** The relay call that writes `key` as this device has it now. */
function write(file: ProjectsFile, key: Key): () => Promise<unknown> {
  const project = file.projects.find((p) => p.id === key[1]);
  const base = `/v1/projects/${segment(key[1])}`;
  if (key[0] === "p") {
    if (!project) return () => relayRequest("DELETE", base);
    const fields: ProjectFields = {
      name: project.name,
      status: project.status,
      notes: project.notes,
      createdAt: project.createdAt,
      settledAt: project.settledAt,
    };
    return () => relayRequest("PUT", base, fields);
  }
  if (key[0] === "t") {
    const [, , email, threadId] = key;
    const route = `${base}/threads/${segment(email)}/${segment(threadId)}`;
    const thread = project?.threads.find((t) => t.email === email && t.threadId === threadId);
    return thread
      ? () => relayRequest("PUT", route, { addedAt: thread.addedAt })
      : () => relayRequest("DELETE", route);
  }
  const route = `${base}/links/${segment(key[2])}`;
  const link = project?.links.find((l) => l.id === key[2]);
  return link
    ? () => relayRequest("PUT", route, { url: link.url, title: link.title, addedAt: link.addedAt })
    : () => relayRequest("DELETE", route);
}

const isProjectKey = (json: string) => json.startsWith('["p"');

/**
 * Writes the pending changes to the relay, projects first so their threads
 * and links have one. Each key leaves `pending` as its write starts: a
 * change made meanwhile queues it again.
 */
function push(): Promise<void> {
  pushing ??= (async () => {
    try {
      while (getOtterUser()) {
        const next = await mutate((file) => {
          const json = file.pending.find(isProjectKey) ?? file.pending[0];
          if (!json) return null;
          file.pending = file.pending.filter((p) => p !== json);
          inFlight = json;
          return { json, send: write(file, JSON.parse(json) as Key) };
        }, true);
        if (!next) return;
        try {
          await next.send();
        } catch (err) {
          // Refused for good (malformed, the project is gone, or full): drop it; otherwise
          // (offline, signed out, the relay failing) try again later.
          if (err instanceof RelayError && [400, 404, 413].includes(err.status)) {
            logger.warn("projects", `The relay refused a project change: ${err.message}`);
            continue;
          }
          logger.info("projects", `Couldn't save a project, retrying: ${String(err)}`);
          await mutate((file) => {
            if (!file.pending.includes(next.json)) file.pending.unshift(next.json);
          }, true);
          schedulePush(RETRY_MS);
          return;
        } finally {
          inFlight = null;
        }
      }
    } finally {
      pushing = null;
    }
  })();
  return pushing;
}

/** The account's projects with this device's pending changes over them. */
function merge(remote: Project[], file: ProjectsFile): Project[] {
  const merged = new Map(remote.map((p) => [p.id, structuredClone(p)]));
  const local = new Map(file.projects.map((p) => [p.id, p]));
  const keys = [...file.pending, ...(inFlight ? [inFlight] : [])].map(
    (json) => JSON.parse(json) as Key,
  );
  for (const [kind, id] of keys) {
    if (kind !== "p") continue;
    const mine = local.get(id);
    if (!mine) {
      merged.delete(id);
      continue;
    }
    const theirs = merged.get(id);
    merged.set(id, {
      ...structuredClone(mine),
      threads: theirs?.threads ?? [],
      links: theirs?.links ?? [],
    });
  }
  for (const key of keys) {
    const target = merged.get(key[1]);
    const mine = local.get(key[1]);
    if (!target || key[0] === "p") continue;
    if (key[0] === "t") {
      const [, , email, threadId] = key;
      const same = (t: ProjectThread) => t.email === email && t.threadId === threadId;
      target.threads = target.threads.filter((t) => !same(t));
      const thread = mine?.threads.find(same);
      if (thread) target.threads.push(thread);
    } else {
      target.links = target.links.filter((l) => l.id !== key[2]);
      const link = mine?.links.find((l) => l.id === key[2]);
      if (link) target.links.push(link);
    }
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Takes the account's projects, keeping this device's changes it doesn't have yet. */
export async function pullProjects(): Promise<void> {
  if (!getOtterUser()) return;
  const { projects } = await relayRequest<ListProjectsResponse>("GET", "/v1/projects");
  await mutate(async (file) => {
    const merged = merge(projects, file);
    // The relay keeps no subjects: this device's, or its mail's.
    const known = new Map(
      file.projects.flatMap((p) => p.threads.map((t) => [`${t.email}:${t.threadId}`, t.subject])),
    );
    for (const thread of merged.flatMap((p) => p.threads)) {
      thread.subject ||=
        known.get(`${thread.email}:${thread.threadId}`) ||
        (await subjectOf(thread.email, thread.threadId));
    }
    file.projects = merged;
  });
  if ((await load()).pending.length > 0) schedulePush(0);
}
