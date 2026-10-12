/**
 * CalendarService - the environment's calendar: accounts (Google or demo), their calendars, and
 * the events synced into SQLite and materialized into per-occurrence rows.
 *
 * RPC handlers and the agent's calendar tools both call this service, so a click and an agent
 * action take the same path. Subscribers get snapshots followed by changes: the directory as a
 * whole on every change, and week chunks of visible instances as diffs.
 *
 * @module CalendarService
 */
import type {
  CalendarAccountId,
  CalendarAddDemoInput,
  CalendarApplyChangesInput,
  CalendarCreateEventInput,
  CalendarDeleteEventInput,
  CalendarDirectory,
  CalendarError,
  CalendarEventDetails,
  CalendarEventInstance,
  CalendarEventRefInput,
  CalendarId,
  CalendarMutationResult,
  CalendarPreferencesPatch,
  CalendarRespondInput,
  CalendarRestoreEventInput,
  CalendarSearchInput,
  CalendarSearchResult,
  CalendarSyncInput,
  CalendarUpdateCalendarInput,
  CalendarUpdateEventInput,
  CalendarWeekEvent,
  CalendarWeekInput,
  GoogleClientInput,
  GoogleConnectCompleteInput,
  GoogleConnectInput,
  GoogleConnectState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface CalendarRangeInput {
  /** Epoch ms, inclusive. */
  readonly start: number;
  /** Epoch ms, exclusive. */
  readonly end: number;
  /** Defaults to every visible calendar. */
  readonly calendarIds?: ReadonlyArray<CalendarId>;
}

export interface FindFreeTimeInput {
  readonly start: number;
  readonly end: number;
  readonly durationMinutes: number;
  /** Defaults to every visible calendar of every account. */
  readonly calendarIds?: ReadonlyArray<CalendarId>;
  /** Keeps slots inside the preferences' working hours (default true). */
  readonly workingHoursOnly?: boolean;
  /** The zone working hours are read in. */
  readonly timeZone: string;
}

export interface FreeSlot {
  readonly start: number;
  readonly end: number;
}

export interface CalendarServiceShape {
  /** Accounts, calendars, preferences and the Google client state: a snapshot on every change. */
  readonly directory: Stream.Stream<CalendarDirectory, CalendarError>;
  readonly getDirectory: Effect.Effect<CalendarDirectory, CalendarError>;
  /** One week chunk of visible instances: a snapshot, then diffs. */
  readonly week: (input: CalendarWeekInput) => Stream.Stream<CalendarWeekEvent, CalendarError>;
  /** Instances overlapping a range, in start order (the agent's reads). */
  readonly listInstances: (
    input: CalendarRangeInput,
  ) => Effect.Effect<ReadonlyArray<CalendarEventInstance>, CalendarError>;
  readonly getEvent: (
    input: CalendarEventRefInput,
  ) => Effect.Effect<CalendarEventDetails, CalendarError>;
  readonly search: (
    input: CalendarSearchInput,
  ) => Effect.Effect<CalendarSearchResult, CalendarError>;
  readonly createEvent: (
    input: CalendarCreateEventInput,
  ) => Effect.Effect<CalendarMutationResult, CalendarError>;
  readonly updateEvent: (
    input: CalendarUpdateEventInput,
  ) => Effect.Effect<CalendarMutationResult, CalendarError>;
  readonly deleteEvent: (
    input: CalendarDeleteEventInput,
  ) => Effect.Effect<CalendarMutationResult, CalendarError>;
  readonly respond: (
    input: CalendarRespondInput,
  ) => Effect.Effect<CalendarMutationResult, CalendarError>;
  readonly restoreEvent: (
    input: CalendarRestoreEventInput,
  ) => Effect.Effect<CalendarMutationResult, CalendarError>;
  /** Runs undo (or redo) steps in order; answers with the steps that revert them. */
  readonly applyChanges: (
    input: CalendarApplyChangesInput,
  ) => Effect.Effect<CalendarMutationResult, CalendarError>;
  readonly updateCalendar: (
    input: CalendarUpdateCalendarInput,
  ) => Effect.Effect<void, CalendarError>;
  readonly updatePreferences: (
    input: CalendarPreferencesPatch,
  ) => Effect.Effect<void, CalendarError>;
  /** Syncs one account (or all) now and waits for it; failures show in the directory. */
  readonly sync: (input: CalendarSyncInput) => Effect.Effect<void, CalendarError>;
  /** Syncs accounts whose data is older than five minutes (before the agent reads). */
  readonly ensureFresh: Effect.Effect<void>;
  readonly removeAccount: (accountId: CalendarAccountId) => Effect.Effect<void, CalendarError>;
  readonly addDemo: (input: CalendarAddDemoInput) => Effect.Effect<void, CalendarError>;
  readonly connect: (input: GoogleConnectInput) => Stream.Stream<GoogleConnectState, CalendarError>;
  readonly connectComplete: (
    input: GoogleConnectCompleteInput,
  ) => Effect.Effect<void, CalendarError>;
  readonly setClient: (input: GoogleClientInput) => Effect.Effect<void, CalendarError>;
  readonly clearClient: Effect.Effect<void, CalendarError>;
  /** Free intervals of at least `durationMinutes`, merging busy time across accounts. */
  readonly findFreeTime: (
    input: FindFreeTimeInput,
  ) => Effect.Effect<ReadonlyArray<FreeSlot>, CalendarError>;
}

export class CalendarService extends Context.Service<CalendarService, CalendarServiceShape>()(
  "t3/calendar/CalendarService",
) {}
