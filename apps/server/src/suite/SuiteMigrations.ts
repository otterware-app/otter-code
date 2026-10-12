/**
 * Module-namespaced migrations for `suite.sqlite`. Each module owns an id
 * sequence of its own, so modules developed in parallel never fight over
 * numbers. The runner applies every unapplied migration in (module, id) order
 * at startup, before any module service starts.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

export interface SuiteMigration {
  /** The owning module's id, e.g. `mail`. */
  readonly module: string;
  /** Positive, unique within the module. Never renumber a shipped migration. */
  readonly id: number;
  readonly name: string;
  readonly run: Effect.Effect<void, SqlError, SqlClient.SqlClient>;
}

export class SuiteMigrationRegistryError extends Schema.TaggedError<SuiteMigrationRegistryError>()(
  "SuiteMigrationRegistryError",
  { module: Schema.String, id: Schema.Number },
) {
  override get message(): string {
    return `Suite migration ${this.module}#${this.id} is registered twice or has an invalid id.`;
  }
}

const compareMigrations = (left: SuiteMigration, right: SuiteMigration) =>
  left.module === right.module ? left.id - right.id : left.module < right.module ? -1 : 1;

const migrationKey = (migration: Pick<SuiteMigration, "module" | "id">) =>
  `${migration.module}#${migration.id}`;

/** Applies unapplied migrations in (module, id) order, each in its own transaction. */
export const runSuiteMigrations = Effect.fn("SuiteMigrations.run")(function* (
  migrations: ReadonlyArray<SuiteMigration>,
) {
  const seen = new Set<string>();
  for (const migration of migrations) {
    const key = migrationKey(migration);
    if (seen.has(key) || !Number.isInteger(migration.id) || migration.id < 1) {
      return yield* new SuiteMigrationRegistryError({
        module: migration.module,
        id: migration.id,
      });
    }
    seen.add(key);
  }

  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS suite_migrations (
      module TEXT NOT NULL,
      id INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (module, id)
    )
  `;
  const appliedRows = yield* sql<{ readonly module: string; readonly id: number }>`
    SELECT module, id FROM suite_migrations
  `;
  const applied = new Set(appliedRows.map(migrationKey));
  const pending = migrations
    .filter((migration) => !applied.has(migrationKey(migration)))
    .toSorted(compareMigrations);

  for (const migration of pending) {
    const appliedAt = DateTime.formatIso(yield* DateTime.now);
    yield* migration.run.pipe(
      Effect.andThen(
        sql`
          INSERT INTO suite_migrations (module, id, name, applied_at)
          VALUES (${migration.module}, ${migration.id}, ${migration.name}, ${appliedAt})
        `,
      ),
      sql.withTransaction,
    );
    yield* Effect.logInfo("Applied suite migration", {
      module: migration.module,
      id: migration.id,
      name: migration.name,
    });
  }
  return pending.map((migration) => migrationKey(migration));
});
