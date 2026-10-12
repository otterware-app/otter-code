/**
 * Home's aggregation: reads every module's contributor, ranks the merged
 * needs-you list, files items under cross-app projects, applies a project or
 * saved view, and derives suggestions. The RPC handlers and the agent tools
 * both call this, so users and agents see the same overview.
 */
import type { ProjectIconColor } from "@t3tools/contracts";
import {
  type SuiteProject,
  type SuiteProjectRules,
  type SuiteHomeContributorStatus,
  type SuiteHomeItem,
  type SuiteHomeItemModule,
  SuiteHomeNotFoundError,
  type SuiteHomeOverview,
  type SuiteHomeOverviewInput,
  type SuiteHomeStoreError,
  type SuiteHomeActionError,
  type SuiteTodayEvent,
} from "@t3tools/contracts/suite";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SuiteHomeContributors, type SuiteHomeContributor } from "../SuiteModule.ts";
import * as CodeHomeActivity from "./CodeHomeActivity.ts";
import {
  filterItems,
  type HomeClock,
  projectCounts,
  rankItems,
  todayEntries,
} from "./homeMatching.ts";
import { suggestNext } from "./homeSuggestions.ts";
import * as SuiteHomeStore from "./SuiteHomeStore.ts";

/** A contributor slower than this is reported as not ok and contributes nothing this round. */
const CONTRIBUTOR_TIMEOUT = "2 seconds";

export class SuiteHome extends Context.Service<
  SuiteHome,
  {
    readonly overview: (
      input: SuiteHomeOverviewInput,
    ) => Effect.Effect<SuiteHomeOverview, SuiteHomeNotFoundError | SuiteHomeStoreError>;
    readonly performAction: (input: {
      readonly module: SuiteHomeItemModule;
      readonly itemId: string;
      readonly actionId: string;
    }) => Effect.Effect<void, SuiteHomeActionError | SuiteHomeNotFoundError>;
    /** Creates a project from partial input: color from the name, empty rules. */
    readonly createProject: (input: {
      readonly name: string;
      readonly color?: ProjectIconColor | undefined;
      readonly icon?: string | undefined;
      readonly rules?: SuiteProjectRules | undefined;
    }) => Effect.Effect<SuiteProject, SuiteHomeNotFoundError | SuiteHomeStoreError>;
    /** Changes only the given fields; `rules` replaces the whole rule set. */
    readonly updateProject: (input: {
      readonly id: string;
      readonly name?: string | undefined;
      readonly color?: ProjectIconColor | undefined;
      readonly icon?: string | undefined;
      readonly rules?: SuiteProjectRules | undefined;
    }) => Effect.Effect<SuiteProject, SuiteHomeNotFoundError | SuiteHomeStoreError>;
  }
>()("t3/suite/home/SuiteHome") {}

const PROJECT_COLORS: ReadonlyArray<ProjectIconColor> = [
  "blue",
  "orange",
  "emerald",
  "violet",
  "pink",
  "teal",
  "amber",
  "indigo",
];

/** A stable color for a new project, so the same name always gets the same one. */
export function defaultProjectColor(name: string): ProjectIconColor {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return PROJECT_COLORS[hash % PROJECT_COLORS.length]!;
}

const EMPTY_RULES: SuiteProjectRules = {
  code: { projectIds: [] },
  mail: { senders: [], domains: [], labels: [], projectIds: [] },
  calendar: { calendarIds: [], keywords: [] },
  drive: { folderIds: [], folderSlugs: [] },
};

interface ContributorRead {
  readonly status: SuiteHomeContributorStatus;
  readonly items: ReadonlyArray<SuiteHomeItem>;
  readonly today: ReadonlyArray<SuiteTodayEvent>;
}

const readContributor = (contributor: SuiteHomeContributor) =>
  Effect.all([contributor.needsYou, contributor.today ?? Effect.succeed([])], {
    concurrency: 2,
  }).pipe(
    Effect.timeoutOption(CONTRIBUTOR_TIMEOUT),
    Effect.map(
      Option.match({
        onNone: (): ContributorRead => ({
          status: { module: contributor.module, ok: false, itemCount: 0 },
          items: [],
          today: [],
        }),
        onSome: ([items, today]): ContributorRead => ({
          status: { module: contributor.module, ok: true, itemCount: items.length },
          // A contributor speaks for its own module only.
          items: items.filter((item) => item.module === contributor.module),
          today,
        }),
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Home contributor failed", { module: contributor.module, cause }).pipe(
        Effect.as<ContributorRead>({
          status: { module: contributor.module, ok: false, itemCount: 0 },
          items: [],
          today: [],
        }),
      ),
    ),
  );

const make = Effect.gen(function* () {
  const contributors = yield* SuiteHomeContributors;
  const store = yield* SuiteHomeStore.SuiteHomeStore;
  const code = yield* CodeHomeActivity.CodeHomeActivity;

  const overview: SuiteHome["Service"]["overview"] = Effect.fn("SuiteHome.overview")(
    function* (input) {
      const [projects, views, reads, codeSnapshot] = yield* Effect.all(
        [
          store.listProjects,
          store.listViews,
          Effect.forEach(contributors, readContributor, { concurrency: "unbounded" }),
          code.snapshot,
        ],
        { concurrency: "unbounded" },
      );
      const project =
        input.projectId === undefined
          ? null
          : (projects.find((candidate) => candidate.id === input.projectId) ?? null);
      if (input.projectId !== undefined && project === null) {
        return yield* new SuiteHomeNotFoundError({ entity: "project", id: input.projectId });
      }
      const view =
        input.viewId === undefined
          ? null
          : (views.find((candidate) => candidate.id === input.viewId) ?? null);
      if (input.viewId !== undefined && view === null) {
        return yield* new SuiteHomeNotFoundError({ entity: "view", id: input.viewId });
      }

      const now = yield* DateTime.now;
      const clock: HomeClock = {
        nowMs: DateTime.toEpochMillis(now),
        todayStartMs: DateTime.toEpochMillis(
          DateTime.startOf(DateTime.setZone(now, DateTime.zoneMakeLocal()), "day"),
        ),
      };
      const allItems = rankItems(
        reads.flatMap((read) => read.items),
        projects,
        clock.nowMs,
      );
      const allToday = todayEntries(
        reads.flatMap((read) => read.today),
        projects,
      );
      const modules = new Set<SuiteHomeItemModule>(["code"]);
      for (const read of reads) if (read.status.ok) modules.add(read.status.module);
      const allSuggestions = suggestNext({
        items: allItems,
        today: allToday,
        projects,
        mergedPullRequests: codeSnapshot.mergedPullRequests,
        modules,
        nowMs: clock.nowMs,
      });

      let items = allItems;
      let today = allToday;
      let suggestions = allSuggestions;
      if (project !== null) {
        items = items.filter((item) => item.projectIds.includes(project.id));
        today = today.filter((event) => event.projectIds.includes(project.id));
        suggestions = suggestions.filter((entry) => entry.projectIds.includes(project.id));
      }
      if (view !== null) {
        const { filter } = view;
        items = filterItems(items, filter, clock);
        today =
          filter.modules.length > 0 && !filter.modules.includes("calendar")
            ? []
            : today.filter(
                (event) =>
                  filter.projectIds.length === 0 ||
                  event.projectIds.some((id) => filter.projectIds.includes(id)),
              );
        suggestions = suggestions.filter(
          (entry) =>
            filter.projectIds.length === 0 ||
            entry.projectIds.some((id) => filter.projectIds.includes(id)),
        );
      }

      return {
        generatedAt: DateTime.formatIso(now),
        items,
        today,
        agents: codeSnapshot.agents,
        suggestions,
        projects: projects.map((entry) => ({
          project: entry,
          counts: projectCounts(entry, allItems, allToday, codeSnapshot.activeThreadsByCodeProject),
        })),
        views,
        contributors: reads.map((read) => read.status),
      } satisfies SuiteHomeOverview;
    },
  );

  const performAction: SuiteHome["Service"]["performAction"] = (input) => {
    const contributor = contributors.find((entry) => entry.module === input.module);
    if (contributor?.performAction === undefined) {
      return Effect.fail(new SuiteHomeNotFoundError({ entity: "contributor", id: input.module }));
    }
    return contributor.performAction(input.itemId, input.actionId);
  };

  const createProject: SuiteHome["Service"]["createProject"] = (input) =>
    store.saveProject({
      name: input.name,
      color: input.color ?? defaultProjectColor(input.name),
      ...(input.icon === undefined ? {} : { icon: input.icon }),
      rules: input.rules ?? EMPTY_RULES,
    });

  const updateProject: SuiteHome["Service"]["updateProject"] = Effect.fn("SuiteHome.updateProject")(
    function* (input) {
      const existing = (yield* store.listProjects).find((project) => project.id === input.id);
      if (existing === undefined) {
        return yield* new SuiteHomeNotFoundError({ entity: "project", id: input.id });
      }
      const icon = input.icon ?? existing.icon;
      return yield* store.saveProject({
        id: existing.id,
        name: input.name ?? existing.name,
        color: input.color ?? existing.color,
        ...(icon === undefined ? {} : { icon }),
        rules: input.rules ?? existing.rules,
      });
    },
  );

  return SuiteHome.of({ overview, performAction, createProject, updateProject });
});

/** Needs `SuiteHomeContributors`, which the suite provides to RPC handlers and toolkits. */
export const layer = Layer.effect(SuiteHome, make);
