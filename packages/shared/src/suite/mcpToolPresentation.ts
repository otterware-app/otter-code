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
  calendar_list_accounts: suiteTool(
    ["List", "Listing", "Listed", "calendar accounts"],
    "calendar-read",
  ),
  calendar_list_events: suiteTool(
    ["List", "Listing", "Listed", "calendar events"],
    "calendar-read",
  ),
  calendar_search_events: suiteTool(
    ["Search", "Searching", "Searched", "calendar events"],
    "calendar-read",
  ),
  calendar_get_event: suiteTool(["Read", "Reading", "Read", "calendar event"], "calendar-read"),
  calendar_find_free_time: suiteTool(["Find", "Finding", "Found", "free time"], "calendar-read"),
  calendar_create_event: suiteTool(
    ["Create", "Creating", "Created", "calendar event"],
    "calendar-change",
  ),
  calendar_update_event: suiteTool(
    ["Update", "Updating", "Updated", "calendar event"],
    "calendar-change",
  ),
  calendar_delete_event: suiteTool(
    ["Delete", "Deleting", "Deleted", "calendar event"],
    "calendar-change",
  ),
  calendar_respond_to_invitation: suiteTool(
    ["Answer", "Answering", "Answered", "invitation"],
    "calendar-change",
  ),
};
