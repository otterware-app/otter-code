/**
 * Projects (services/projects.ts): the renderer's channels. Every change is
 * broadcast as `projects:changed`, whoever made it (a window, an agent, or
 * another device through the relay).
 */

import type { ProjectStatus } from "@otter-mail/contracts/projects";

import { handle } from "../ipc.js";
import { listAccounts } from "../services/account-store.js";
import * as mailStore from "../services/mail-store.js";
import * as projects from "../services/projects.js";
import type { GmailAccount, GmailMessageSummary } from "../types.js";
import { runAsTask } from "./ipc-budget.js";

type Params = Record<string, unknown> | undefined;

function str(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid parameter: "${name}".`);
  return value;
}

const optional = (value: unknown) => (typeof value === "string" ? value : undefined);

const status = (value: unknown): ProjectStatus | undefined =>
  value === "active" || value === "settled" ? value : undefined;

async function project(id: string) {
  const found = (await projects.listProjects()).find((p) => p.id === id);
  if (!found) throw new Error("No such project.");
  return found;
}

/** A project's conversation as a list row, if this device has it. */
function threadRow(
  accounts: GmailAccount[],
  email: string,
  threadId: string,
): GmailMessageSummary | null {
  const account = accounts.find((a) => a.email.toLowerCase() === email);
  const row = account && mailStore.getThreadSummaries(account.id, [threadId])[0];
  return row ? { ...row, accountId: account.id } : null;
}

export function registerProjectHandlers(): void {
  handle("projects:list", () => projects.listProjects());

  handle("projects:create", async (params: unknown) => {
    const p = params as Params;
    const created = await projects.createProject({
      name: str(p?.name, "name"),
      notes: optional(p?.notes),
    });
    const threads = Array.isArray(p?.threads) ? (p.threads as unknown[]) : [];
    return threads.length > 0 ? addThreads(created.id, threads) : created;
  });

  handle("projects:update", async (params: unknown) => {
    const p = params as Params;
    return projects.updateProject(str(p?.id, "id"), {
      name: optional(p?.name),
      notes: optional(p?.notes),
      status: status(p?.status),
    });
  });

  handle("projects:delete", async (params: unknown) =>
    projects.deleteProject(str((params as Params)?.id, "id")),
  );

  // Threads come from the renderer by accountId; projects name mailboxes by address.
  async function addThreads(id: string, threads: unknown[]) {
    const accounts = await listAccounts();
    return projects.addThreads(
      id,
      threads.flatMap((t) => {
        const { accountId, threadId, subject } = (t ?? {}) as Record<string, unknown>;
        const account = accounts.find((a) => a.id === accountId);
        if (!account || typeof threadId !== "string") return [];
        return [{ email: account.email, threadId, subject: optional(subject) }];
      }),
    );
  }

  handle("projects:addThreads", async (params: unknown) => {
    const p = params as Params;
    return addThreads(str(p?.id, "id"), Array.isArray(p?.threads) ? p.threads : []);
  });

  handle("projects:removeThread", async (params: unknown) => {
    const p = params as Params;
    return projects.removeThread(
      str(p?.id, "id"),
      str(p?.email, "email"),
      str(p?.threadId, "threadId"),
    );
  });

  handle("projects:addLink", async (params: unknown) => {
    const p = params as Params;
    return projects.addLink(str(p?.id, "id"), {
      url: str(p?.url, "url"),
      title: optional(p?.title),
    });
  });

  handle("projects:removeLink", async (params: unknown) => {
    const p = params as Params;
    return projects.removeLink(str(p?.id, "id"), str(p?.linkId, "linkId"));
  });

  // A project's conversations this device has, as list rows (newest first),
  // and the ones it doesn't; without an id, every active project's.
  handle("projects:threads", async (params: unknown) => {
    const id = optional((params as Params)?.id);
    const threads = id
      ? (await project(id)).threads
      : (await projects.listProjects())
          .filter((p) => p.status === "active")
          .flatMap((p) => p.threads);
    const accounts = await listAccounts();
    const rows = new Map<string, GmailMessageSummary>();
    const missing: typeof threads = [];
    for (const thread of threads) {
      const row = threadRow(accounts, thread.email, thread.threadId);
      if (row) rows.set(`${row.accountId}:${row.threadId}`, row);
      else missing.push(thread);
    }
    return { messages: [...rows.values()].sort((a, b) => b.date - a.date), missing };
  });

  // Unread conversations in each active project, for the sidebar.
  handle("projects:unreadCounts", async () => {
    const accounts = await listAccounts();
    const counts: Record<string, number> = {};
    for (const p of await projects.listProjects()) {
      if (p.status !== "active") continue;
      counts[p.id] = p.threads.filter(
        (t) => threadRow(accounts, t.email, t.threadId)?.threadUnread,
      ).length;
    }
    return counts;
  });

  // Can fetch messages this device hasn't opened: a task, past the IPC budget.
  handle("projects:documents", async (params: unknown) => {
    const p = params as Params;
    const id = str(p?.id, "id");
    return runAsTask(optional(p?.taskId), async () => projects.projectDocuments(await project(id)));
  });
}
