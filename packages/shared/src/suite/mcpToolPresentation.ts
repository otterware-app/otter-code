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
  mail_list_accounts: suiteTool(["List", "Listing", "Listed", "mail accounts"], null),
  mail_list_labels: suiteTool(["List", "Listing", "Listed", "mail labels"], null),
  mail_list_threads: suiteTool(["List", "Listing", "Listed", "mail threads"], null),
  mail_search_mail: suiteTool(["Search", "Searching", "Searched", "mail"], null),
  mail_get_thread: suiteTool(["Read", "Reading", "Read", "mail thread"], null),
  mail_get_attachment: suiteTool(["Read", "Reading", "Read", "mail attachment"], null),
  mail_update_threads: suiteTool(["Update", "Updating", "Updated", "mail threads"], null),
  mail_trash_threads: suiteTool(["Trash", "Trashing", "Trashed", "mail threads"], null),
  mail_restore_threads: suiteTool(["Restore", "Restoring", "Restored", "mail threads"], null),
  mail_create_label: suiteTool(["Create", "Creating", "Created", "mail label"], null),
  mail_save_draft: suiteTool(["Save", "Saving", "Saved", "mail draft"], null),
  mail_delete_draft: suiteTool(["Delete", "Deleting", "Deleted", "mail draft"], null),
  mail_send_email: suiteTool(["Send", "Sending", "Sent", "email"], null),
  mail_list_views: suiteTool(["List", "Listing", "Listed", "mail views"], null),
  mail_save_view: suiteTool(["Save", "Saving", "Saved", "mail view"], null),
  mail_delete_view: suiteTool(["Delete", "Deleting", "Deleted", "mail view"], null),
  mail_list_projects: suiteTool(["List", "Listing", "Listed", "mail projects"], null),
  mail_get_project: suiteTool(["Read", "Reading", "Read", "mail project"], null),
  mail_create_project: suiteTool(["Create", "Creating", "Created", "mail project"], null),
  mail_update_project: suiteTool(["Update", "Updating", "Updated", "mail project"], null),
  mail_set_project_status: suiteTool(["Set", "Setting", "Set", "mail project status"], null),
  mail_add_to_project: suiteTool(
    ["Add", "Adding", "Added", "conversations to a Mail project"],
    null,
  ),
  mail_remove_from_project: suiteTool(
    ["Remove", "Removing", "Removed", "conversations from a Mail project"],
    null,
  ),
};
