// @effect-diagnostics nodeBuiltinImport:off -- Runs in Mail's worker thread, outside any Effect runtime.
/**
 * Mail's agent tools for every Code thread. The list comes from core at
 * runtime (`agentTools`), so tools Mail adds upstream appear on the next
 * sync; calendar tools are the Calendar module's and themes Otter Code's, so
 * those two sets are left out. One ToolCaller per thread and access: core
 * orders a caller's changes and keys approvals on it. The thread's own MCP
 * approval already applies, so callers run in full-access mode, limited by
 * the access the thread's runtime mode grants.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import { agentTools, runAgentTool, type AgentTool, type ToolCaller } from "@otter-mail/core";

import { calendarTools } from "../../../../../../vendor/otter-mail/packages/core/src/services/agent/tools/calendar.ts";
import { themeTools } from "../../../../../../vendor/otter-mail/packages/core/src/services/agent/tools/themes.ts";
import type { MailToolCaller, MailToolDescriptor } from "./protocol.ts";
import { mailWorkerData } from "./workerLink.ts";

const EXCLUDED = new Set([...calendarTools, ...themeTools].map((tool) => tool.name));

/**
 * Attachments for agents on this server: Code threads run here, so a saved
 * attachment's path is one the agent can read, and a path it names is one
 * the server can attach.
 */
const files: NonNullable<ToolCaller["files"]> = {
  async save(name, bytes) {
    const dir = NodePath.join(mailWorkerData.home, "agent-attachments", NodeCrypto.randomUUID());
    await NodeFS.mkdir(dir, { recursive: true });
    const file = NodePath.join(dir, NodePath.basename(name) || "attachment");
    await NodeFS.writeFile(file, bytes, { mode: 0o600 });
    return file;
  },
  async read(path) {
    return { name: NodePath.basename(path), bytes: new Uint8Array(await NodeFS.readFile(path)) };
  },
};

const callers = new Map<string, ToolCaller>();

function callerFor(caller: MailToolCaller): ToolCaller {
  const key = `${caller.key}\u0000${caller.access}`;
  let toolCaller = callers.get(key);
  if (!toolCaller) {
    toolCaller = {
      mode: () => "full-access",
      turn: () => null,
      access: () => caller.access,
      files,
    };
    callers.set(key, toolCaller);
  }
  return toolCaller;
}

const describe = (tool: AgentTool): MailToolDescriptor => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  input: tool.input,
  readOnly: tool.readOnly === true,
  permanent: tool.permanent === true,
});

/** Every tool Otterware offers, regardless of a caller's access (MCP lists them once). */
export function listMailTools(): ReadonlyArray<MailToolDescriptor> {
  return agentTools(callerFor({ key: "listing", access: "full-access" }))
    .filter((tool) => !EXCLUDED.has(tool.name))
    .map(describe);
}

export function callMailTool(
  caller: MailToolCaller,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  if (EXCLUDED.has(name)) return Promise.resolve({ text: `No tool "${name}".`, isError: true });
  const toolCaller = callerFor(caller);
  const allowed = agentTools(toolCaller).some((tool) => tool.name === name);
  if (!allowed) {
    return Promise.resolve({
      text: `${name} changes the user's mailboxes in a way this thread's access mode does not allow. Ask the user to run it, or to give the thread full access.`,
      isError: true,
    });
  }
  return runAgentTool(toolCaller, name, args);
}
