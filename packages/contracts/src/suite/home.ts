import * as Schema from "effect/Schema";

import { IsoDateTime } from "../baseSchemas.ts";

export const SuiteHomeItemModule = Schema.Literals(["code", "mail", "calendar", "drive"]);
export type SuiteHomeItemModule = typeof SuiteHomeItemModule.Type;

export const SuiteHomeItemAction = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  primary: Schema.optional(Schema.Boolean),
});
export type SuiteHomeItemAction = typeof SuiteHomeItemAction.Type;

/** Where the client goes when the item is opened: a web route and its params. */
export const SuiteHomeItemTarget = Schema.Struct({
  route: Schema.String,
  params: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type SuiteHomeItemTarget = typeof SuiteHomeItemTarget.Type;

/** One "needs you" entry on Home, contributed by a module's `homeContributor`. */
export const SuiteHomeItem = Schema.Struct({
  /** Stable within its module; `performAction` receives it back. */
  id: Schema.String,
  module: SuiteHomeItemModule,
  kind: Schema.String,
  title: Schema.String,
  subtitle: Schema.optional(Schema.String),
  projectKey: Schema.optional(Schema.String),
  occurredAt: IsoDateTime,
  /** Higher sorts first. */
  priority: Schema.Number,
  agentNote: Schema.optional(Schema.String),
  actions: Schema.Array(SuiteHomeItemAction),
  target: SuiteHomeItemTarget,
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
