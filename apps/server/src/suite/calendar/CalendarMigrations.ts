/**
 * Otter Calendar's schema, in `suite.sqlite` under the `calendar` namespace. Upstream ships it
 * as the main database's migration 3 (vendored as `calendar/migrations/003_Calendar.ts`); here
 * it is the calendar module's migration 1. A later upstream calendar migration becomes id 2.
 */
import Migration003Calendar from "../../calendar/migrations/003_Calendar.ts";
import type { SuiteMigration } from "../SuiteMigrations.ts";

export const CALENDAR_MIGRATIONS: ReadonlyArray<SuiteMigration> = [
  { module: "calendar", id: 1, name: "calendar_schema", run: Migration003Calendar },
];
