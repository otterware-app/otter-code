/**
 * Home for agents: what needs the user today, and the cross-app projects that
 * group mail, events, files and Code threads. Reads match what the user sees
 * on Home; writes are limited to project definitions.
 */
import { McpCapabilityUnavailableError, ProjectIconColor } from "@t3tools/contracts";
import {
  SuiteHomeNotFoundError,
  SuiteHomeOverview,
  SuiteHomeStoreError,
  SuiteProject,
  SuiteProjectRules,
  SuiteProjectSummary,
  SuiteView,
} from "@t3tools/contracts/suite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as SuiteHome from "./SuiteHome.ts";

const failure = Schema.Union([
  McpCapabilityUnavailableError,
  SuiteHomeNotFoundError,
  SuiteHomeStoreError,
]);
const dependencies = [McpInvocationContext.McpInvocationContext];

/** Agents get the top of the list; the user's Home shows the rest. */
const MAX_TOOL_ITEMS = 40;

const RULES_DESCRIPTION =
  "Rules decide which items belong to the project; any one rule matching is enough. code.projectIds: Otter Code project ids (t3_project_list). mail.senders: full addresses; mail.domains: e.g. acme.com; mail.labels; mail.projectIds: Mail module project ids. calendar.calendarIds; calendar.keywords: words in event titles. drive.folderIds and drive.folderSlugs.";

const SuiteHomeOverviewTool = Tool.make("suite_home_overview", {
  description:
    "What needs the user now across Code, Mail, Calendar and Drive: the ranked 'needs you' list (each item has its module, kind, title, why, and the cross-app projects it belongs to), today's events, agents running or waiting, and rule-based suggested next steps. Use it to answer 'what needs me today?'. Pass projectId or viewId to narrow it.",
  parameters: Schema.Struct({
    projectId: Schema.optional(Schema.String),
    viewId: Schema.optional(Schema.String),
  }),
  success: SuiteHomeOverview,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Read Home overview")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SuiteListProjectsTool = Tool.make("suite_list_projects", {
  description:
    "List the user's cross-app projects (each groups Code projects, mail senders/labels, calendars and Drive folders under one name) with per-module counts, and their saved Home views.",
  success: Schema.Struct({
    projects: Schema.Array(SuiteProjectSummary),
    views: Schema.Array(SuiteView),
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "List cross-app projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SuiteGetProjectOverviewTool = Tool.make("suite_get_project_overview", {
  description:
    "Everything Home knows for one cross-app project: its needs-you items across modules, today's matching events, suggestions, and its per-module counts.",
  parameters: Schema.Struct({ projectId: Schema.String }),
  success: SuiteHomeOverview,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Read a cross-app project")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SuiteCreateProjectTool = Tool.make("suite_create_project", {
  description: `Create a cross-app project the user asked for. ${RULES_DESCRIPTION}`,
  parameters: Schema.Struct({
    name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(80)),
    color: Schema.optional(ProjectIconColor),
    icon: Schema.optional(Schema.String),
    rules: Schema.optional(SuiteProjectRules),
  }),
  success: SuiteProject,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Create a cross-app project")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const SuiteUpdateProjectTool = Tool.make("suite_update_project", {
  description: `Rename, recolor, or change the rules of a cross-app project. Omitted fields stay; rules replaces the whole rule set, so read the project first and send every rule to keep. ${RULES_DESCRIPTION}`,
  parameters: Schema.Struct({
    id: Schema.String,
    name: Schema.optional(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(80))),
    color: Schema.optional(ProjectIconColor),
    icon: Schema.optional(Schema.String),
    rules: Schema.optional(SuiteProjectRules),
  }),
  success: SuiteProject,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Update a cross-app project")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const SuiteHomeToolkit = Toolkit.make(
  SuiteHomeOverviewTool,
  SuiteListProjectsTool,
  SuiteGetProjectOverviewTool,
  SuiteCreateProjectTool,
  SuiteUpdateProjectTool,
);

const requireSuite = McpInvocationContext.requireMcpCapability("suite");

const trimmed = (overview: SuiteHomeOverview): SuiteHomeOverview => ({
  ...overview,
  items: overview.items.slice(0, MAX_TOOL_ITEMS),
});

export const layerHandlers = SuiteHomeToolkit.toLayer(
  Effect.gen(function* () {
    const home = yield* SuiteHome.SuiteHome;
    return SuiteHomeToolkit.of({
      suite_home_overview: (input) =>
        requireSuite.pipe(Effect.andThen(home.overview(input)), Effect.map(trimmed)),
      suite_list_projects: () =>
        requireSuite.pipe(
          Effect.andThen(home.overview({})),
          Effect.map(({ projects, views }) => ({ projects, views })),
        ),
      suite_get_project_overview: ({ projectId }) =>
        requireSuite.pipe(Effect.andThen(home.overview({ projectId })), Effect.map(trimmed)),
      suite_create_project: (input) => requireSuite.pipe(Effect.andThen(home.createProject(input))),
      suite_update_project: (input) => requireSuite.pipe(Effect.andThen(home.updateProject(input))),
    });
  }),
).pipe(Layer.provide(SuiteHome.layer));
