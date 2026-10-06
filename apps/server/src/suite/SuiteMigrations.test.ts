import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SuiteDatabase from "./SuiteDatabase.ts";
import { runSuiteMigrations, type SuiteMigration } from "./SuiteMigrations.ts";

const layer = SuiteDatabase.layerSqlClient.pipe(Layer.provideMerge(SuiteDatabase.layerMemory));

const createTable = (module: string, id: number, table: string): SuiteMigration => ({
  module,
  id,
  name: `create_${table}`,
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
  }),
});

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `;
  return rows.map((row) => row.name);
});

it.layer(layer)("SuiteMigrations", (it) => {
  it.effect("applies pending migrations in (module, id) order, once", () =>
    Effect.gen(function* () {
      const first = yield* runSuiteMigrations([
        createTable("mail", 2, "mail_threads"),
        createTable("calendar", 1, "calendar_events"),
        createTable("mail", 1, "mail_accounts"),
      ]);
      assert.deepStrictEqual(first, ["calendar#1", "mail#1", "mail#2"]);

      // A second boot with a module added later only runs the new migration.
      const second = yield* runSuiteMigrations([
        createTable("mail", 1, "mail_accounts"),
        createTable("mail", 2, "mail_threads"),
        createTable("calendar", 1, "calendar_events"),
        createTable("drive", 1, "drive_files"),
      ]);
      assert.deepStrictEqual(second, ["drive#1"]);

      const sql = yield* SqlClient.SqlClient;
      const recorded = yield* sql<{ readonly module: string; readonly id: number }>`
        SELECT module, id FROM suite_migrations ORDER BY module, id
      `;
      assert.deepStrictEqual(
        recorded.map((row) => `${row.module}#${row.id}`),
        ["calendar#1", "drive#1", "mail#1", "mail#2"],
      );
      assert.includeMembers(yield* tableNames, [
        "calendar_events",
        "drive_files",
        "mail_accounts",
        "mail_threads",
      ]);
    }),
  );

  it.effect("rolls back a failing migration and leaves it pending", () =>
    Effect.gen(function* () {
      const broken: SuiteMigration = {
        module: "broken",
        id: 1,
        name: "half_done",
        run: Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE broken_half (id TEXT)`;
          yield* sql`INSERT INTO table_that_does_not_exist VALUES (1)`;
        }),
      };
      const exit = yield* Effect.exit(runSuiteMigrations([broken]));
      assert.isTrue(Exit.isFailure(exit));
      assert.notInclude(yield* tableNames, "broken_half");

      const sql = yield* SqlClient.SqlClient;
      const recorded = yield* sql<{ readonly id: number }>`
        SELECT id FROM suite_migrations WHERE module = 'broken'
      `;
      assert.strictEqual(recorded.length, 0);
    }),
  );

  it.effect("rejects duplicate or invalid ids before touching the database", () =>
    Effect.gen(function* () {
      const duplicate = yield* Effect.flip(
        runSuiteMigrations([createTable("dup", 1, "dup_a"), createTable("dup", 1, "dup_b")]),
      );
      assert.strictEqual(duplicate._tag, "SuiteMigrationRegistryError");
      const invalid = yield* Effect.flip(runSuiteMigrations([createTable("zero", 0, "zero_a")]));
      assert.strictEqual(invalid._tag, "SuiteMigrationRegistryError");
      assert.notInclude(yield* tableNames, "dup_a");
    }),
  );
});
