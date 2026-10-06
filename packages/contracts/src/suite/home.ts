import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import { IsoDateTime } from "../baseSchemas.ts";
import { ProjectIconColor } from "../project.ts";
import { defineSuiteContract } from "./contract.ts";

export const SuiteHomeItemModule = Schema.Literals(["code", "mail", "calendar", "drive"]);
export type SuiteHomeItemModule = typeof SuiteHomeItemModule.Type;

/**
 * Where the client goes when the item is opened: a web route and its params
 * (`$environmentId` defaults to the environment Home read the item from), or
 * an absolute `https:` URL the client opens outside the app.
 */
export const SuiteHomeItemTarget = Schema.Struct({
  route: Schema.String,
  params: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type SuiteHomeItemTarget = typeof SuiteHomeItemTarget.Type;

/**
 * One button on a Home row. How the client runs it, first match wins:
 * - `target`: navigate there (no server round trip);
 * - `startThread`: start a new Code thread with `prompt` (in `codeProjectId`,
 *   else the Otterware Assistant project), carrying the item as context;
 * - otherwise: `suite.home.performAction`, which calls the contributor's
 *   `performAction(itemId, id)`.
 */
export const SuiteHomeItemAction = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  primary: Schema.optional(Schema.Boolean),
  target: Schema.optional(SuiteHomeItemTarget),
  startThread: Schema.optional(
    Schema.Struct({
      prompt: Schema.String,
      codeProjectId: Schema.optional(Schema.String),
    }),
  ),
});
export type SuiteHomeItemAction = typeof SuiteHomeItemAction.Type;

/**
 * What an item is about, so Home can file it under cross-app projects
 * (`SuiteProjectRules`). Every field is optional: fill what the module knows.
 * An item without facets still shows on Home, it just matches no project
 * except through a calendar title keyword.
 */
export const SuiteHomeItemFacets = Schema.Struct({
  /** Code: the Otter Code project id the thread belongs to. */
  codeProjectId: Schema.optional(Schema.String),
  /** Code: the thread id. */
  threadId: Schema.optional(Schema.String),
  /** Mail: participant addresses (sender first); calendar: attendee addresses. Any case. */
  senders: Schema.optional(Schema.Array(Schema.String)),
  /** Mail: label names or ids. */
  labels: Schema.optional(Schema.Array(Schema.String)),
  /** Mail: the Mail module's own project/folder ids the message is filed under. */
  mailProjectIds: Schema.optional(Schema.Array(Schema.String)),
  /** Calendar: the calendar id. */
  calendarId: Schema.optional(Schema.String),
  /** Drive: the item's folder and its ancestors' ids, nearest first. */
  folderIds: Schema.optional(Schema.Array(Schema.String)),
  /** Drive: the same folders as human-readable slugs or paths. */
  folderSlugs: Schema.optional(Schema.Array(Schema.String)),
  /** Calendar/Mail: Drive file ids linked to the event or message (e.g. meeting notes). */
  driveFileIds: Schema.optional(Schema.Array(Schema.String)),
});
export type SuiteHomeItemFacets = typeof SuiteHomeItemFacets.Type;

/**
 * One "needs you" entry on Home, contributed by a module's `homeContributor`.
 *
 * `priority` convention (higher sorts first): 90 an agent is blocked on the
 * user (approval, question); 80 a person waits on a reply or RSVP; 60 a
 * review or decision is due; 40 something finished worth a look; 20 FYI.
 */
export const SuiteHomeItem = Schema.Struct({
  /** Stable within its module; `performAction` receives it back. */
  id: Schema.String,
  module: SuiteHomeItemModule,
  kind: Schema.String,
  title: Schema.String,
  subtitle: Schema.optional(Schema.String),
  /** Home assigns the first matching cross-app project from `facets`; contributors may omit it. */
  projectKey: Schema.optional(Schema.String),
  occurredAt: IsoDateTime,
  /** Higher sorts first. */
  priority: Schema.Number,
  agentNote: Schema.optional(Schema.String),
  actions: Schema.Array(SuiteHomeItemAction),
  target: SuiteHomeItemTarget,
  /** Someone (a person or an agent) is blocked until the user acts. Feeds "Waiting on me". */
  waitingOnYou: Schema.optional(Schema.Boolean),
  facets: Schema.optional(SuiteHomeItemFacets),
});
export type SuiteHomeItem = typeof SuiteHomeItem.Type;

/** One event on Home's calendar strip for today. */
export const SuiteTodayEvent = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  allDay: Schema.Boolean,
  location: Schema.optional(Schema.String),
  /** Joinable meeting link, when the event has one. */
  conferenceUrl: Schema.optional(Schema.String),
  calendarName: Schema.optional(Schema.String),
  color: Schema.optional(Schema.String),
  target: SuiteHomeItemTarget,
  /** `calendarId`, attendee addresses in `senders`, linked notes in `driveFileIds`. */
  facets: Schema.optional(SuiteHomeItemFacets),
});
export type SuiteTodayEvent = typeof SuiteTodayEvent.Type;

/** A Home action a contributor could not perform. */
export class SuiteHomeActionError extends Schema.TaggedError<SuiteHomeActionError>()(
  "SuiteHomeActionError",
  {
    module: SuiteHomeItemModule,
    itemId: Schema.String,
    actionId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not run ${this.actionId} on ${this.module} item ${this.itemId}.`;
  }
}

// -- Cross-app projects and views ---------------------------------------------

const stringList = Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([])));

/**
 * Which items belong to a cross-app project. An item matches when ANY rule
 * matches; empty lists match nothing. Comparisons ignore case.
 */
export const SuiteProjectRules = Schema.Struct({
  code: Schema.Struct({ projectIds: stringList }).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  mail: Schema.Struct({
    /** Full addresses, matched against `facets.senders`. */
    senders: stringList,
    /** Domains (`acme.com`), matched against the senders' domains and subdomains. */
    domains: stringList,
    labels: stringList,
    /** The Mail module's own project ids (`facets.mailProjectIds`). */
    projectIds: stringList,
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  calendar: Schema.Struct({
    calendarIds: stringList,
    /** Words in calendar item or event titles. */
    keywords: stringList,
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  drive: Schema.Struct({
    folderIds: stringList,
    folderSlugs: stringList,
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type SuiteProjectRules = typeof SuiteProjectRules.Type;

export const SuiteProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: ProjectIconColor,
  /** A Lucide icon name; clients show a monogram when absent. */
  icon: Schema.optional(Schema.String),
  rules: SuiteProjectRules,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SuiteProject = typeof SuiteProject.Type;

export const SuiteViewTimeRange = Schema.Literals(["any", "today", "7d", "30d"]);
export type SuiteViewTimeRange = typeof SuiteViewTimeRange.Type;

/** A saved filter over Home items. Empty lists mean "any". */
export const SuiteViewFilter = Schema.Struct({
  modules: Schema.Array(SuiteHomeItemModule).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  projectIds: stringList,
  kinds: stringList,
  timeRange: SuiteViewTimeRange.pipe(Schema.withDecodingDefault(Effect.succeed("any" as const))),
  waitingOnMe: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type SuiteViewFilter = typeof SuiteViewFilter.Type;

export const SuiteView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.optional(Schema.String),
  filter: SuiteViewFilter,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SuiteView = typeof SuiteView.Type;

// -- Overview -------------------------------------------------------------------

/** A Home item after ranking, with the cross-app projects it matched. */
export const SuiteHomeRankedItem = Schema.Struct({
  ...SuiteHomeItem.fields,
  projectIds: Schema.Array(Schema.String),
  score: Schema.Number,
});
export type SuiteHomeRankedItem = typeof SuiteHomeRankedItem.Type;

export const SuiteHomeTodayEntry = Schema.Struct({
  ...SuiteTodayEvent.fields,
  projectIds: Schema.Array(Schema.String),
});
export type SuiteHomeTodayEntry = typeof SuiteHomeTodayEntry.Type;

export const SuiteHomeAgentsSummary = Schema.Struct({
  running: Schema.Int,
  waiting: Schema.Int,
  recentlyFinished: Schema.Int,
});
export type SuiteHomeAgentsSummary = typeof SuiteHomeAgentsSummary.Type;

/** A rule-based cross-app next step. The client starts a thread with `action.prompt`. */
export const SuiteHomeSuggestion = Schema.Struct({
  id: Schema.String,
  /** Which rule produced it, e.g. `mail-bug-to-code`. */
  rule: Schema.String,
  from: SuiteHomeItemModule,
  to: SuiteHomeItemModule,
  title: Schema.String,
  /** One sentence on why it is suggested. */
  reason: Schema.String,
  action: Schema.Struct({
    label: Schema.String,
    prompt: Schema.String,
    /** Start in this Code project; else the Otterware Assistant project. */
    codeProjectId: Schema.optional(Schema.String),
  }),
  projectIds: Schema.Array(Schema.String),
});
export type SuiteHomeSuggestion = typeof SuiteHomeSuggestion.Type;

export const SuiteHomeModuleCounts = Schema.Struct({
  code: Schema.Int,
  mail: Schema.Int,
  calendar: Schema.Int,
  drive: Schema.Int,
});
export type SuiteHomeModuleCounts = typeof SuiteHomeModuleCounts.Type;

export const SuiteProjectSummary = Schema.Struct({
  project: SuiteProject,
  /** Needs-you items per module; `code` also counts active threads in the linked Code projects. */
  counts: SuiteHomeModuleCounts,
});
export type SuiteProjectSummary = typeof SuiteProjectSummary.Type;

export const SuiteHomeContributorStatus = Schema.Struct({
  module: SuiteHomeItemModule,
  /** False when the contributor's last read failed or timed out. */
  ok: Schema.Boolean,
  itemCount: Schema.Int,
});
export type SuiteHomeContributorStatus = typeof SuiteHomeContributorStatus.Type;

export const SuiteHomeOverviewInput = Schema.Struct({
  /** Only items matching this cross-app project. */
  projectId: Schema.optional(Schema.String),
  /** Only items matching this saved view. */
  viewId: Schema.optional(Schema.String),
});
export type SuiteHomeOverviewInput = typeof SuiteHomeOverviewInput.Type;

export const SuiteHomeOverview = Schema.Struct({
  generatedAt: IsoDateTime,
  items: Schema.Array(SuiteHomeRankedItem),
  today: Schema.Array(SuiteHomeTodayEntry),
  agents: SuiteHomeAgentsSummary,
  suggestions: Schema.Array(SuiteHomeSuggestion),
  projects: Schema.Array(SuiteProjectSummary),
  views: Schema.Array(SuiteView),
  contributors: Schema.Array(SuiteHomeContributorStatus),
});
export type SuiteHomeOverview = typeof SuiteHomeOverview.Type;

export const SuiteProjectInput = Schema.Struct({
  /** Omit to create. */
  id: Schema.optional(Schema.String),
  name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(80)),
  color: ProjectIconColor,
  icon: Schema.optional(Schema.String),
  rules: SuiteProjectRules,
});
export type SuiteProjectInput = typeof SuiteProjectInput.Type;

export const SuiteViewInput = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(80)),
  icon: Schema.optional(Schema.String),
  filter: SuiteViewFilter,
});
export type SuiteViewInput = typeof SuiteViewInput.Type;

export const SuiteAssistantProject = Schema.Struct({
  projectId: Schema.String,
  workspaceRoot: Schema.String,
});
export type SuiteAssistantProject = typeof SuiteAssistantProject.Type;

export class SuiteHomeNotFoundError extends Schema.TaggedError<SuiteHomeNotFoundError>()(
  "SuiteHomeNotFoundError",
  {
    entity: Schema.Literals(["project", "view", "contributor", "action"]),
    id: Schema.String,
  },
) {
  override get message(): string {
    return `No such Home ${this.entity}: ${this.id}.`;
  }
}

export class SuiteHomeStoreError extends Schema.TaggedError<SuiteHomeStoreError>()(
  "SuiteHomeStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Home could not ${this.operation}.`;
  }
}

export class SuiteAssistantProjectError extends Schema.TaggedError<SuiteAssistantProjectError>()(
  "SuiteAssistantProjectError",
  {
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not prepare the Otterware Assistant project.";
  }
}

export const SUITE_HOME_METHODS = {
  overview: "suite.home.overview",
  performAction: "suite.home.performAction",
  saveProject: "suite.home.saveProject",
  deleteProject: "suite.home.deleteProject",
  saveView: "suite.home.saveView",
  deleteView: "suite.home.deleteView",
  ensureAssistantProject: "suite.home.ensureAssistantProject",
} as const;

const SuiteHomeOverviewRpc = Rpc.make(SUITE_HOME_METHODS.overview, {
  payload: SuiteHomeOverviewInput,
  success: SuiteHomeOverview,
  error: Schema.Union([SuiteHomeNotFoundError, SuiteHomeStoreError, EnvironmentAuthorizationError]),
});

const SuiteHomePerformActionRpc = Rpc.make(SUITE_HOME_METHODS.performAction, {
  payload: Schema.Struct({
    module: SuiteHomeItemModule,
    itemId: Schema.String,
    actionId: Schema.String,
  }),
  success: Schema.Struct({}),
  error: Schema.Union([
    SuiteHomeActionError,
    SuiteHomeNotFoundError,
    EnvironmentAuthorizationError,
  ]),
});

const SuiteHomeSaveProjectRpc = Rpc.make(SUITE_HOME_METHODS.saveProject, {
  payload: SuiteProjectInput,
  success: SuiteProject,
  error: Schema.Union([SuiteHomeNotFoundError, SuiteHomeStoreError, EnvironmentAuthorizationError]),
});

const SuiteHomeDeleteProjectRpc = Rpc.make(SUITE_HOME_METHODS.deleteProject, {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({}),
  error: Schema.Union([SuiteHomeStoreError, EnvironmentAuthorizationError]),
});

const SuiteHomeSaveViewRpc = Rpc.make(SUITE_HOME_METHODS.saveView, {
  payload: SuiteViewInput,
  success: SuiteView,
  error: Schema.Union([SuiteHomeNotFoundError, SuiteHomeStoreError, EnvironmentAuthorizationError]),
});

const SuiteHomeDeleteViewRpc = Rpc.make(SUITE_HOME_METHODS.deleteView, {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({}),
  error: Schema.Union([SuiteHomeStoreError, EnvironmentAuthorizationError]),
});

const SuiteHomeEnsureAssistantProjectRpc = Rpc.make(SUITE_HOME_METHODS.ensureAssistantProject, {
  payload: Schema.Struct({}),
  success: SuiteAssistantProject,
  error: Schema.Union([SuiteAssistantProjectError, EnvironmentAuthorizationError]),
});

export const SuiteHomeRpcGroup = RpcGroup.make(
  SuiteHomeOverviewRpc,
  SuiteHomePerformActionRpc,
  SuiteHomeSaveProjectRpc,
  SuiteHomeDeleteProjectRpc,
  SuiteHomeSaveViewRpc,
  SuiteHomeDeleteViewRpc,
  SuiteHomeEnsureAssistantProjectRpc,
);

export const SuiteHomeContract = defineSuiteContract({
  group: SuiteHomeRpcGroup,
  scopes: {
    [SUITE_HOME_METHODS.overview]: AuthOrchestrationReadScope,
    [SUITE_HOME_METHODS.performAction]: AuthOrchestrationOperateScope,
    [SUITE_HOME_METHODS.saveProject]: AuthOrchestrationOperateScope,
    [SUITE_HOME_METHODS.deleteProject]: AuthOrchestrationOperateScope,
    [SUITE_HOME_METHODS.saveView]: AuthOrchestrationOperateScope,
    [SUITE_HOME_METHODS.deleteView]: AuthOrchestrationOperateScope,
    [SUITE_HOME_METHODS.ensureAssistantProject]: AuthOrchestrationOperateScope,
  },
});
