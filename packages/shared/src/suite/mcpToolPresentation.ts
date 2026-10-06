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
  drive_list_folders: suiteTool(["List", "Listing", "Listed", "Drive folders"], "drive"),
  drive_list_documents: suiteTool(["List", "Listing", "Listed", "Drive documents"], "drive"),
  drive_get_document: suiteTool(["Get", "Getting", "Got", "Drive document"], "drive"),
  drive_read_document: suiteTool(["Read", "Reading", "Read", "Drive document"], "drive"),
  drive_create_document: suiteTool(["Create", "Creating", "Created", "Drive document"], "drive"),
  drive_update_document: suiteTool(["Update", "Updating", "Updated", "Drive document"], "drive"),
  drive_link_document_to_thread: suiteTool(
    ["Link", "Linking", "Linked", "Drive document"],
    "drive",
  ),
  drive_unlink_document_from_thread: suiteTool(
    ["Unlink", "Unlinking", "Unlinked", "Drive document"],
    "drive",
  ),
  drive_list_thread_documents: suiteTool(
    ["List", "Listing", "Listed", "thread Drive documents"],
    "drive",
  ),
};
