/**
 * Display names for Otterware module MCP tools, merged into the T3 tool
 * inventory in `../t3McpToolPresentation.ts`. A module adds its tools here.
 */
import type { T3McpToolDefinition } from "../t3McpToolPresentation.ts";

const suiteTool = (
  labels: T3McpToolDefinition["labels"],
  summaryAction: T3McpToolDefinition["summaryAction"],
): T3McpToolDefinition => ({
  displayName: `${labels[0]} ${labels[3]}`,
  labels,
  icon: "t3-code",
  summaryAction,
});

export const SUITE_MCP_TOOLS: Readonly<Record<string, T3McpToolDefinition>> = {
  suite_capabilities: suiteTool(["List", "Listing", "Listed", "Otterware modules"], "capabilities"),
};
