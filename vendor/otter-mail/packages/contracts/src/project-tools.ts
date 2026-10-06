/**
 * The tools an agent manages projects with, over MCP. Two places serve them
 * on their own store: core (with its mail and calendar tools, which the Mac
 * app serves to Claude and Codex) and the relay (`/mcp`, for agents that run
 * elsewhere, like Hermes). Mailboxes are named by address, as `account`, like
 * core's mail tools.
 */

import { z } from "zod";

import {
  PROJECT_LIMITS,
  type Project,
  type ProjectDocument,
  type ProjectLink,
  type ProjectStatus,
} from "./projects.js";

/** A store of projects, the relay's or a device's. */
export interface ProjectBackend {
  list(): Promise<Project[]>;
  create(input: { name: string; notes: string }): Promise<Project>;
  /** Throws when there's no such project. */
  update(id: string, patch: Partial<Pick<Project, "name" | "notes" | "status">>): Promise<Project>;
  addThread(id: string, thread: { email: string; threadId: string }): Promise<void>;
  removeThread(id: string, email: string, threadId: string): Promise<void>;
  addLink(id: string, link: { url: string; title: string }): Promise<ProjectLink>;
  removeLink(id: string, linkId: string): Promise<void>;
  /** The project's documents, where the mail is at hand (a device, not the relay). */
  documents?(project: Project): Promise<ProjectDocument[]>;
}

/** A tool, served as MCP's `tools/call`. `run` answers what the agent reads back (as JSON). */
export interface ProjectTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /** Reads only: needs no approval. */
  readOnly: boolean;
  /** What a change will do, for the user to approve ("Settle “Acme”"); reads have none. */
  describe?(args: Record<string, unknown>): Promise<string>;
  run(args: Record<string, unknown>): Promise<unknown>;
}

/** A tool's arguments as JSON Schema, for MCP's `tools/list`. */
export function inputJsonSchema(tool: ProjectTool): {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
} {
  return z.toJSONSchema(z.object(tool.inputSchema), { io: "input" }) as never;
}

const projectId = z.string().describe("The project's id (from list_projects).");
const account = z
  .string()
  .describe("The mailbox, by its email address.")
  .transform((email) => email.trim().toLowerCase());
const threadRef = z.object({
  account,
  threadId: z.string().min(1).describe("The conversation's thread id."),
});
const linkInput = z.object({
  url: z.url().max(PROJECT_LIMITS.url),
  title: z.string().max(PROJECT_LIMITS.title).optional().describe("Defaults to the URL."),
});

/** What an agent sees of a project in a list. */
function summary(project: Project) {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    conversations: project.threads.length,
    links: project.links.length,
    updatedAt: new Date(project.updatedAt).toISOString(),
    ...(project.settledAt ? { settledAt: new Date(project.settledAt).toISOString() } : {}),
  };
}

async function detail(backend: ProjectBackend, project: Project) {
  return {
    ...summary(project),
    notes: project.notes,
    conversations: project.threads.map((t) => ({
      account: t.email,
      threadId: t.threadId,
      ...(t.subject ? { subject: t.subject } : {}),
    })),
    links: project.links,
    ...(backend.documents
      ? {
          documents: (await backend.documents(project)).map((doc) => ({
            name: doc.name,
            versions: doc.versions.map((v) => ({
              filename: v.filename,
              from: v.from,
              date: new Date(v.date).toISOString(),
              size: v.size,
              account: v.email,
              threadId: v.threadId,
              messageId: v.messageId,
              attachmentId: v.attachmentId,
            })),
          })),
        }
      : {}),
  };
}

async function find(backend: ProjectBackend, id: string): Promise<Project> {
  const project = (await backend.list()).find((p) => p.id === id);
  if (!project) throw new Error(`No project ${id}; list_projects has their ids.`);
  return project;
}

const addThreads = async (
  backend: ProjectBackend,
  id: string,
  threads: z.infer<typeof threadRef>[],
) => {
  for (const t of threads) {
    await backend.addThread(id, { email: t.account, threadId: t.threadId });
  }
};

const addLinks = async (
  backend: ProjectBackend,
  id: string,
  links: z.infer<typeof linkInput>[],
) => {
  for (const l of links) await backend.addLink(id, { url: l.url, title: l.title || l.url });
};

/** A tool whose `run` (and `describe`) get its arguments parsed by its schema. */
export function defineTool<S extends z.ZodRawShape>(
  spec: Omit<ProjectTool, "inputSchema" | "run" | "describe"> & {
    inputSchema: S;
    describe?: (args: z.infer<z.ZodObject<S>>) => Promise<string>;
    run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
  },
): ProjectTool {
  const parse = (args: Record<string, unknown>) => z.object(spec.inputSchema).parse(args);
  const describe = spec.describe;
  return {
    ...spec,
    describe: describe && ((args) => describe(parse(args))),
    run: (args) => spec.run(parse(args)),
  };
}

/** "3 conversations and a link". */
function counted(conversations: number, links: number): string {
  const parts = [
    conversations ? `${conversations} conversation${conversations === 1 ? "" : "s"}` : "",
    links ? (links === 1 ? "a link" : `${links} links`) : "",
  ].filter(Boolean);
  return parts.join(" and ");
}

/** Runs a tool for MCP's `tools/call`: its answer as JSON text, or its error as the result. */
export async function callTool(
  tool: ProjectTool,
  args: Record<string, unknown>,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await tool.run(args), null, 2) }] };
  } catch (err) {
    const message =
      err instanceof z.ZodError
        ? z.prettifyError(err)
        : err instanceof Error
          ? err.message
          : String(err);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

/** The project tools, run against `backend`. */
export function projectTools(backend: ProjectBackend): ProjectTool[] {
  const tool = defineTool;
  const nameOf = async (id: string) => `“${(await find(backend, id)).name}”`;
  return [
    tool({
      name: "list_projects",
      title: "List projects",
      description:
        "Projects gather the conversations, documents, links and notes of one piece of work (a contract, a hire, a deal) until it's settled. Lists them, active first.",
      readOnly: true,
      inputSchema: {
        status: z.enum(["active", "settled", "all"]).default("active"),
      },
      async run({ status }) {
        const projects = await backend.list();
        return projects
          .filter((p) => status === "all" || p.status === status)
          .sort((a, b) => a.status.localeCompare(b.status) || b.updatedAt - a.updatedAt)
          .map(summary);
      },
    }),
    tool({
      name: "get_project",
      title: "Get a project",
      description:
        "A project's notes, conversations (account and threadId), links and, where the mail is available, its documents: its conversations' attachments, grouped into versions of each document, newest first.",
      readOnly: true,
      inputSchema: { projectId },
      run: async ({ projectId }) => detail(backend, await find(backend, projectId)),
    }),
    tool({
      name: "create_project",
      title: "Create a project",
      description:
        "Starts a project, optionally with its first conversations and links. Look for the related conversations first (search_mail, where available) so the project starts complete.",
      readOnly: false,
      inputSchema: {
        name: z.string().trim().min(1).max(PROJECT_LIMITS.name),
        notes: z.string().max(PROJECT_LIMITS.notes).default(""),
        conversations: z.array(threadRef).max(100).default([]),
        links: z.array(linkInput).max(50).default([]),
      },
      describe: async ({ name, conversations, links }) => {
        const with_ = counted(conversations.length, links.length);
        return `Create the project “${name}”${with_ ? `, with ${with_}` : ""}`;
      },
      async run({ name, notes, conversations, links }) {
        const project = await backend.create({ name, notes });
        await addThreads(backend, project.id, conversations);
        await addLinks(backend, project.id, links);
        return detail(backend, await find(backend, project.id));
      },
    }),
    tool({
      name: "update_project",
      title: "Update a project",
      description:
        "Renames a project or replaces its notes. Notes are where things stand: open points, who's waiting on whom, the latest version agreed. Read them first (get_project) and keep what still holds.",
      readOnly: false,
      inputSchema: {
        projectId,
        name: z.string().trim().min(1).max(PROJECT_LIMITS.name).optional(),
        notes: z.string().max(PROJECT_LIMITS.notes).optional(),
      },
      describe: async ({ projectId, name, notes }) =>
        [
          name ? `Rename ${await nameOf(projectId)} to “${name}”` : "",
          notes !== undefined ? `Replace the notes of ${await nameOf(projectId)}:\n${notes}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      run: async ({ projectId, name, notes }) =>
        summary(await backend.update(projectId, { name, notes })),
    }),
    tool({
      name: "set_project_status",
      title: "Settle or reopen a project",
      description:
        "Settles a project when its work is done (it moves to Settled, with everything kept), or reopens a settled one.",
      readOnly: false,
      inputSchema: {
        projectId,
        status: z.enum(["active", "settled"] satisfies [ProjectStatus, ProjectStatus]),
      },
      describe: async ({ projectId, status }) =>
        `${status === "settled" ? "Settle" : "Reopen"} ${await nameOf(projectId)}`,
      run: async ({ projectId, status }) => summary(await backend.update(projectId, { status })),
    }),
    tool({
      name: "add_to_project",
      title: "Add conversations and links to a project",
      description:
        "Adds conversations (by account and threadId) and links (a shared document, a signing page, a data room) to a project. Adding one it already has changes nothing.",
      readOnly: false,
      inputSchema: {
        projectId,
        conversations: z.array(threadRef).max(100).default([]),
        links: z.array(linkInput).max(50).default([]),
      },
      describe: async ({ projectId, conversations, links }) =>
        `Add ${counted(conversations.length, links.length) || "nothing"} to ${await nameOf(projectId)}`,
      async run({ projectId, conversations, links }) {
        await find(backend, projectId);
        await addThreads(backend, projectId, conversations);
        await addLinks(backend, projectId, links);
        return summary(await find(backend, projectId));
      },
    }),
    tool({
      name: "remove_from_project",
      title: "Remove conversations or links from a project",
      description:
        "Takes conversations or links out of a project. The mail itself stays where it is.",
      readOnly: false,
      inputSchema: {
        projectId,
        conversations: z.array(threadRef).max(100).default([]),
        linkIds: z.array(z.string()).max(50).default([]),
      },
      describe: async ({ projectId, conversations, linkIds }) =>
        `Take ${counted(conversations.length, linkIds.length) || "nothing"} out of ${await nameOf(projectId)}`,
      async run({ projectId, conversations, linkIds }) {
        await find(backend, projectId);
        for (const t of conversations) await backend.removeThread(projectId, t.account, t.threadId);
        for (const id of linkIds) await backend.removeLink(projectId, id);
        return summary(await find(backend, projectId));
      },
    }),
  ];
}
