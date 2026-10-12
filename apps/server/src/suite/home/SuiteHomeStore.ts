/**
 * Cross-app projects and saved views, in `suite.sqlite` (module `home`). Rules
 * and filters are stored as JSON and decoded leniently: a row written by a
 * newer build keeps working with the fields this build knows.
 */
import { ProjectIconColor } from "@t3tools/contracts";
import {
  SuiteHomeNotFoundError,
  SuiteHomeStoreError,
  type SuiteProject,
  type SuiteProjectInput,
  SuiteProjectRules,
  type SuiteView,
  SuiteViewFilter,
  type SuiteViewInput,
} from "@t3tools/contracts/suite";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { SuiteMigration } from "../SuiteMigrations.ts";

export const HOME_MIGRATIONS: ReadonlyArray<SuiteMigration> = [
  {
    module: "home",
    id: 1,
    name: "suite_projects_and_views",
    run: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE suite_projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          color TEXT NOT NULL,
          icon TEXT,
          rules_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE TABLE suite_views (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          icon TEXT,
          filter_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `;
    }),
  },
];

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly icon: string | null;
  readonly rules_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ViewRow {
  readonly id: string;
  readonly name: string;
  readonly icon: string | null;
  readonly filter_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const decodeRules = Schema.decodeUnknownEffect(Schema.fromJsonString(SuiteProjectRules));
const decodeFilter = Schema.decodeUnknownEffect(Schema.fromJsonString(SuiteViewFilter));
const encodeRules = Schema.encodeEffect(Schema.fromJsonString(SuiteProjectRules));
const encodeFilter = Schema.encodeEffect(Schema.fromJsonString(SuiteViewFilter));
const decodeColor = Schema.decodeUnknownEffect(ProjectIconColor);

export class SuiteHomeStore extends Context.Service<
  SuiteHomeStore,
  {
    readonly listProjects: Effect.Effect<ReadonlyArray<SuiteProject>, SuiteHomeStoreError>;
    readonly listViews: Effect.Effect<ReadonlyArray<SuiteView>, SuiteHomeStoreError>;
    /** Creates the project when `input.id` is absent, else replaces it. */
    readonly saveProject: (
      input: SuiteProjectInput,
    ) => Effect.Effect<SuiteProject, SuiteHomeNotFoundError | SuiteHomeStoreError>;
    readonly deleteProject: (id: string) => Effect.Effect<void, SuiteHomeStoreError>;
    readonly saveView: (
      input: SuiteViewInput,
    ) => Effect.Effect<SuiteView, SuiteHomeNotFoundError | SuiteHomeStoreError>;
    readonly deleteView: (id: string) => Effect.Effect<void, SuiteHomeStoreError>;
  }
>()("t3/suite/home/SuiteHomeStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const storeError = (operation: string) => (cause: unknown) =>
    new SuiteHomeStoreError({ operation, cause });

  const toProject = (row: ProjectRow) =>
    Effect.gen(function* () {
      const rules = yield* decodeRules(row.rules_json).pipe(
        Effect.catch(() => decodeRules("{}")),
        Effect.orDie,
      );
      const color = yield* decodeColor(row.color).pipe(
        Effect.orElseSucceed((): ProjectIconColor => "gray"),
      );
      return {
        id: row.id,
        name: row.name,
        color,
        ...(row.icon === null ? {} : { icon: row.icon }),
        rules,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } satisfies SuiteProject;
    });

  const toView = (row: ViewRow) =>
    Effect.gen(function* () {
      const filter = yield* decodeFilter(row.filter_json).pipe(
        Effect.catch(() => decodeFilter("{}")),
        Effect.orDie,
      );
      return {
        id: row.id,
        name: row.name,
        ...(row.icon === null ? {} : { icon: row.icon }),
        filter,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } satisfies SuiteView;
    });

  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const newId = (prefix: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((id) => `${prefix}_${id.replaceAll("-", "").slice(0, 16)}`),
      Effect.mapError(storeError("allocate an id")),
    );

  const listProjects = sql<ProjectRow>`
    SELECT id, name, color, icon, rules_json, created_at, updated_at
    FROM suite_projects ORDER BY created_at, id
  `.pipe(
    Effect.mapError(storeError("list projects")),
    Effect.flatMap((rows) => Effect.forEach(rows, toProject)),
  );

  const listViews = sql<ViewRow>`
    SELECT id, name, icon, filter_json, created_at, updated_at
    FROM suite_views ORDER BY created_at, id
  `.pipe(
    Effect.mapError(storeError("list views")),
    Effect.flatMap((rows) => Effect.forEach(rows, toView)),
  );

  const saveProject: SuiteHomeStore["Service"]["saveProject"] = Effect.fn(
    "SuiteHomeStore.saveProject",
  )(function* (input) {
    const timestamp = yield* now;
    const rulesJson = yield* encodeRules(input.rules).pipe(
      Effect.mapError(storeError("encode project rules")),
    );
    const name = input.name.trim();
    const icon = input.icon ?? null;
    if (input.id === undefined) {
      const id = yield* newId("proj");
      yield* sql`
        INSERT INTO suite_projects (id, name, color, icon, rules_json, created_at, updated_at)
        VALUES (${id}, ${name}, ${input.color}, ${icon}, ${rulesJson}, ${timestamp}, ${timestamp})
      `.pipe(Effect.mapError(storeError("create a project")));
      return {
        id,
        name,
        color: input.color,
        ...(input.icon ? { icon: input.icon } : {}),
        rules: input.rules,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    }
    const rows = yield* sql<ProjectRow>`
      UPDATE suite_projects
      SET name = ${name}, color = ${input.color}, icon = ${icon},
          rules_json = ${rulesJson}, updated_at = ${timestamp}
      WHERE id = ${input.id}
      RETURNING id, name, color, icon, rules_json, created_at, updated_at
    `.pipe(Effect.mapError(storeError("update a project")));
    const row = rows[0];
    if (row === undefined) {
      return yield* new SuiteHomeNotFoundError({ entity: "project", id: input.id });
    }
    return yield* toProject(row);
  });

  const deleteProject: SuiteHomeStore["Service"]["deleteProject"] = (id) =>
    sql`DELETE FROM suite_projects WHERE id = ${id}`.pipe(
      Effect.asVoid,
      Effect.mapError(storeError("delete a project")),
    );

  const saveView: SuiteHomeStore["Service"]["saveView"] = Effect.fn("SuiteHomeStore.saveView")(
    function* (input) {
      const timestamp = yield* now;
      const filterJson = yield* encodeFilter(input.filter).pipe(
        Effect.mapError(storeError("encode the view filter")),
      );
      const name = input.name.trim();
      const icon = input.icon ?? null;
      if (input.id === undefined) {
        const id = yield* newId("view");
        yield* sql`
          INSERT INTO suite_views (id, name, icon, filter_json, created_at, updated_at)
          VALUES (${id}, ${name}, ${icon}, ${filterJson}, ${timestamp}, ${timestamp})
        `.pipe(Effect.mapError(storeError("create a view")));
        return {
          id,
          name,
          ...(input.icon ? { icon: input.icon } : {}),
          filter: input.filter,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      }
      const rows = yield* sql<ViewRow>`
        UPDATE suite_views
        SET name = ${name}, icon = ${icon}, filter_json = ${filterJson}, updated_at = ${timestamp}
        WHERE id = ${input.id}
        RETURNING id, name, icon, filter_json, created_at, updated_at
      `.pipe(Effect.mapError(storeError("update a view")));
      const row = rows[0];
      if (row === undefined) {
        return yield* new SuiteHomeNotFoundError({ entity: "view", id: input.id });
      }
      return yield* toView(row);
    },
  );

  const deleteView: SuiteHomeStore["Service"]["deleteView"] = (id) =>
    sql`DELETE FROM suite_views WHERE id = ${id}`.pipe(
      Effect.asVoid,
      Effect.mapError(storeError("delete a view")),
    );

  return SuiteHomeStore.of({
    listProjects,
    listViews,
    saveProject,
    deleteProject,
    saveView,
    deleteView,
  });
});

/** Needs `suite.sqlite` as the plain `SqlClient`: provide `SuiteDatabase.layerSqlClient`. */
export const layer = Layer.effect(SuiteHomeStore, make);
