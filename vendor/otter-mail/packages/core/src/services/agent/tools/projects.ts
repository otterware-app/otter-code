/**
 * The project tools (contracts' project-tools.ts, which the relay serves
 * too) on this device's projects, as core's agent tools: a change asks the
 * chat's user first, saying what it will do, like the mail tools.
 */

import { inputJsonSchema, projectTools as tools } from "@otter-mail/contracts/project-tools";

import { localBackend } from "../../projects.js";
import type { AgentTool } from "./tool.js";

export const projectTools: AgentTool[] = tools(localBackend).map((tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  input: inputJsonSchema(tool),
  readOnly: tool.readOnly,
  async run(args, ctx) {
    if (tool.describe) await ctx.confirm(await tool.describe(args));
    const result = await tool.run(args);
    if (!tool.readOnly) {
      const project = result as { id: string; name: string };
      ctx.changed?.({
        action: tool.name === "create_project" ? "created" : "updated",
        title: project.name,
        target: { kind: "project", id: project.id },
      });
    }
    return result;
  },
}));
