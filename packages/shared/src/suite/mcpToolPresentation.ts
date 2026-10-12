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
  suite_home_overview: suiteTool(["Read", "Reading", "Read", "Home overview"], "project-list"),
  suite_list_projects: suiteTool(
    ["List", "Listing", "Listed", "cross-app projects"],
    "project-list",
  ),
  suite_get_project_overview: suiteTool(
    ["Read", "Reading", "Read", "cross-app project"],
    "project-read",
  ),
  suite_create_project: suiteTool(
    ["Create", "Creating", "Created", "cross-app project"],
    "project-create",
  ),
  suite_update_project: suiteTool(
    ["Update", "Updating", "Updated", "cross-app project"],
    "project-update",
  ),
};
