/**
 * The in-memory database Otter Calendar's vendored tests build on. Upstream imports
 * `SqlitePersistenceMemory` from its `persistence/Layers/Sqlite.ts` (its main database with all
 * migrations); the vendor manifest remaps that import here, to an in-memory `suite.sqlite` with
 * the calendar module's migrations.
 */
import * as Layer from "effect/Layer";

import * as SuiteDatabase from "../../SuiteDatabase.ts";
import { runSuiteMigrations } from "../../SuiteMigrations.ts";
import { CALENDAR_MIGRATIONS } from "../CalendarMigrations.ts";

export const SqlitePersistenceMemory = Layer.effectDiscard(
  runSuiteMigrations(CALENDAR_MIGRATIONS),
).pipe(
  Layer.provideMerge(SuiteDatabase.layerSqlClient),
  Layer.provideMerge(SuiteDatabase.layerMemory),
);
