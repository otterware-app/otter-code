import { TOOL_INSTRUCTIONS } from "../../../../../vendor/otter-mail/packages/core/src/services/agent/instructions.ts";

/** Keep Mail's guidance current on sync, with suite tool names and ownership. */
export const MAIL_INSTRUCTIONS = `## Mail

${TOOL_INSTRUCTIONS.split("\n")
  .filter((line) => !line.includes("color themes"))
  .map((line) =>
    line
      .replace(" and their calendars", "")
      .replace("otter-mail tools", "mail_* tools")
      .replace(", list_events, create_event", "")
      .replace(" or calendars", "")
      .replace(" or calendar", "")
      .replace(
        /\b(list_accounts|search_mail|list_threads|get_thread|get_attachment|update_threads|save_draft|send_email|list_projects|create_project|add_to_project|update_project|set_project_status|list_views|save_view|delete_view)\b/g,
        "mail_$1",
      ),
  )
  .join("\n")}
Calendar events belong to the Calendar module. Threads without full access can only make changes that can be undone.`;
