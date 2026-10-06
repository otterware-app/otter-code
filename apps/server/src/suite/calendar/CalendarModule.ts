/**
 * Otterware Calendar: Otter Calendar's service (vendored under `apps/server/src/calendar/`, see
 * `scripts/otterware/vendor/otter-calendar.json`) on `suite.sqlite`, its RPCs as
 * `suite.calendar.*`, its agent tools in every Code thread, and today's events for Home.
 *
 * Google sign-in keeps Otter Calendar's behaviour: a loopback PKCE flow on the server (the
 * desktop app forwards the redirect for remote environments), the OAuth client from Settings,
 * `T3CODE_GOOGLE_CLIENT_ID`/`_SECRET` or the build, and tokens in the server's secret store.
 * Calendar preferences live in `calendar_preferences` in `suite.sqlite`.
 */
import * as Layer from "effect/Layer";

import * as CalendarServiceLive from "../../calendar/CalendarServiceLive.ts";
import * as GoogleAuthLive from "../../calendar/google/GoogleAuthLive.ts";
import * as SuiteDatabase from "../SuiteDatabase.ts";
import { defineSuiteServerModule } from "../SuiteModule.ts";
import { makeCalendarHomeContributor } from "./CalendarHome.ts";
import { CALENDAR_MIGRATIONS } from "./CalendarMigrations.ts";
import * as CalendarRpcHandlers from "./CalendarRpcHandlers.ts";
import * as CalendarToolkit from "./CalendarToolkit.ts";

export const CALENDAR_AGENT_INSTRUCTIONS = `## Calendar

The user's calendars (Google accounts and demo accounts, combined in Otterware's Calendar) are yours through the \`calendar_*\` tools: \`calendar_list_accounts\`, \`calendar_list_events\`, \`calendar_search_events\`, \`calendar_get_event\`, \`calendar_create_event\`, \`calendar_update_event\`, \`calendar_delete_event\`, \`calendar_respond_to_invitation\` and \`calendar_find_free_time\`. Use them for anything about the user's schedule rather than files or shell commands; they change the calendar the same way the app does, and the user sees the result at once.

Pass the user's time zone as \`timeZone\` (the calendar page's context names it; otherwise the calendar's own preference applies) and state times in that zone. When scheduling, use \`calendar_find_free_time\` instead of reading events and guessing. Ask before deleting anything the user did not clearly ask you to delete, and before answering an invitation for them. When a change to a recurring event is ambiguous, ask whether it applies to this occurrence, this and following ones, or all of them.`;

const layer = CalendarServiceLive.layer.pipe(
  Layer.provide(GoogleAuthLive.layer),
  Layer.provide(SuiteDatabase.layerSqlClient),
);

export const CalendarModule = defineSuiteServerModule({
  id: "calendar",
  migrations: CALENDAR_MIGRATIONS,
  layer,
  rpcHandlers: CalendarRpcHandlers.layer,
  mcpToolkit: CalendarToolkit.layer,
  agentInstructions: CALENDAR_AGENT_INSTRUCTIONS,
  homeContributor: makeCalendarHomeContributor,
});
