// @effect-diagnostics globalDate:off -- Fixtures build ISO times relative to the test clock.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  SuiteHomeActionError,
  type SuiteHomeItem,
  SuiteProjectRules,
} from "@t3tools/contracts/suite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as SuiteDatabase from "../SuiteDatabase.ts";
import { runSuiteMigrations } from "../SuiteMigrations.ts";
import { type SuiteHomeContributor, SuiteHomeContributors } from "../SuiteModule.ts";
import * as CodeHomeActivity from "./CodeHomeActivity.ts";
import * as SuiteHome from "./SuiteHome.ts";
import * as SuiteHomeStore from "./SuiteHomeStore.ts";

const decodeRules = Schema.decodeUnknownSync(SuiteProjectRules);
const recently = () => new Date(Date.now() - 60_000).toISOString();

const homeItem = (overrides: Partial<SuiteHomeItem> & Pick<SuiteHomeItem, "id" | "module">) =>
  ({
    kind: "thing",
    title: overrides.id,
    occurredAt: recently(),
    priority: 50,
    actions: [],
    target: { route: "/home" },
    ...overrides,
  }) satisfies SuiteHomeItem;

const performed: Array<string> = [];

const contributors: ReadonlyArray<SuiteHomeContributor> = [
  {
    module: "mail",
    needsYou: Effect.sync(() => [
      homeItem({
        id: "mail-1",
        module: "mail",
        priority: 80,
        waitingOnYou: true,
        facets: { senders: ["eva@acme.com"] },
      }),
      // Contributors speak for their own module only.
      homeItem({ id: "spoofed", module: "code", priority: 99 }),
    ]),
    performAction: (itemId, actionId) =>
      itemId === "mail-1"
        ? Effect.sync(() => void performed.push(`${itemId}:${actionId}`))
        : Effect.fail(new SuiteHomeActionError({ module: "mail", itemId, actionId })),
  },
  {
    module: "calendar",
    needsYou: Effect.succeed([homeItem({ id: "cal-1", module: "calendar", priority: 60 })]),
    today: Effect.succeed([
      {
        id: "ev-1",
        title: "Acme weekly",
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
        endsAt: new Date(Date.now() + 7_200_000).toISOString(),
        allDay: false,
        target: { route: "/calendar" },
      },
    ]),
  },
  { module: "drive", needsYou: Effect.die("drive is down") },
  {
    module: "code",
    needsYou: Effect.succeed([
      homeItem({ id: "code-1", module: "code", priority: 95, facets: { codeProjectId: "c-1" } }),
    ]),
  },
];

const layerCode = Layer.succeed(CodeHomeActivity.CodeHomeActivity, {
  snapshot: Effect.succeed({
    ok: true,
    items: [],
    agents: { running: 2, waiting: 1, recentlyFinished: 3 },
    activeThreadsByCodeProject: new Map([["c-1", 5]]),
    mergedPullRequests: [],
  }),
  contributor: contributors[3]!,
});

const layerStore = SuiteHomeStore.layer.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(runSuiteMigrations(SuiteHomeStore.HOME_MIGRATIONS)).pipe(
      Layer.provideMerge(SuiteDatabase.layerSqlClient),
    ),
  ),
  Layer.provide(SuiteDatabase.layerMemory),
  Layer.provide(NodeServices.layer),
);

const layer = SuiteHome.layer.pipe(
  Layer.provideMerge(layerStore),
  Layer.provide(layerCode),
  Layer.provide(Layer.succeed(SuiteHomeContributors, contributors)),
);

it.layer(layer)("SuiteHome", (it) => {
  describe("overview", () => {
    it.effect("merges and ranks every contributor, reporting the ones that failed", () =>
      Effect.gen(function* () {
        const home = yield* SuiteHome.SuiteHome;
        const overview = yield* home.overview({});
        assert.deepStrictEqual(
          overview.items.map((item) => item.id),
          ["code-1", "mail-1", "cal-1"],
        );
        assert.deepStrictEqual(
          overview.contributors.map((status) => [status.module, status.ok, status.itemCount]),
          [
            ["mail", true, 2],
            ["calendar", true, 1],
            ["drive", false, 0],
            ["code", true, 1],
          ],
        );
        assert.deepStrictEqual(
          overview.today.map((event) => event.id),
          ["ev-1"],
        );
        assert.deepStrictEqual(overview.agents, { running: 2, waiting: 1, recentlyFinished: 3 });
      }),
    );

    it.effect("files items under projects and narrows to a project or a view", () =>
      Effect.gen(function* () {
        const home = yield* SuiteHome.SuiteHome;
        const store = yield* SuiteHomeStore.SuiteHomeStore;
        const acme = yield* home.createProject({
          name: "Acme",
          rules: decodeRules({
            code: { projectIds: ["c-1"] },
            mail: { domains: ["acme.com"] },
            calendar: { keywords: ["acme"] },
          }),
        });
        assert.strictEqual(acme.color, SuiteHome.defaultProjectColor("Acme"));

        const overview = yield* home.overview({});
        const summary = overview.projects.find((entry) => entry.project.id === acme.id);
        assert.deepStrictEqual(summary?.counts, { code: 5, mail: 1, calendar: 1, drive: 0 });

        const scoped = yield* home.overview({ projectId: acme.id });
        assert.deepStrictEqual(
          scoped.items.map((item) => item.id),
          ["code-1", "mail-1"],
        );
        assert.deepStrictEqual(
          scoped.today.map((event) => event.id),
          ["ev-1"],
        );

        const view = yield* store.saveView({
          name: "Waiting on me",
          filter: {
            modules: [],
            projectIds: [],
            kinds: [],
            timeRange: "any",
            waitingOnMe: true,
          },
        });
        const waiting = yield* home.overview({ viewId: view.id });
        assert.deepStrictEqual(
          waiting.items.map((item) => item.id),
          ["mail-1"],
        );

        const renamed = yield* home.updateProject({ id: acme.id, name: "Acme GmbH" });
        assert.strictEqual(renamed.name, "Acme GmbH");
        assert.deepStrictEqual(renamed.rules, acme.rules);

        const missing = yield* home.overview({ projectId: "nope" }).pipe(Effect.flip);
        assert.strictEqual(missing._tag, "SuiteHomeNotFoundError");

        yield* store.deleteProject(acme.id);
        yield* store.deleteView(view.id);
        const after = yield* home.overview({});
        assert.deepStrictEqual(after.projects, []);
        assert.deepStrictEqual(after.views, []);
      }),
    );
  });

  it.effect("routes actions to the item's module and reports unknown modules", () =>
    Effect.gen(function* () {
      const home = yield* SuiteHome.SuiteHome;
      yield* home.performAction({ module: "mail", itemId: "mail-1", actionId: "archive" });
      assert.deepStrictEqual(performed, ["mail-1:archive"]);
      const failed = yield* home
        .performAction({ module: "mail", itemId: "gone", actionId: "archive" })
        .pipe(Effect.flip);
      assert.strictEqual(failed._tag, "SuiteHomeActionError");
      const noContributor = yield* home
        .performAction({ module: "calendar", itemId: "cal-1", actionId: "accept" })
        .pipe(Effect.flip);
      assert.strictEqual(noContributor._tag, "SuiteHomeNotFoundError");
    }),
  );
});
