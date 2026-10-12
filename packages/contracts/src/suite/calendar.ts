/**
 * Otterware Calendar's wire surface: Otter Calendar's RPCs (vendored schemas in `../calendar.ts`)
 * under the suite's `suite.calendar.*` names.
 *
 * `SUITE_CALENDAR_METHODS` keeps Otter Calendar's `WS_METHODS` keys, so the vendored client
 * state (`client-runtime/src/state/calendar.ts`) reads it in place of `WS_METHODS` unchanged.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import {
  CalendarAccountRefInput,
  CalendarAddDemoInput,
  CalendarApplyChangesInput,
  CalendarCreateEventInput,
  CalendarDeleteEventInput,
  CalendarDirectory,
  CalendarError,
  CalendarEventDetails,
  CalendarEventRefInput,
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
} from "../calendar.ts";
import { defineSuiteContract } from "./contract.ts";

export const SUITE_CALENDAR_METHODS = {
  calendarSubscribeDirectory: "suite.calendar.subscribeDirectory",
  calendarSubscribeWeek: "suite.calendar.subscribeWeek",
  calendarGetEvent: "suite.calendar.getEvent",
  calendarSearch: "suite.calendar.search",
  calendarCreateEvent: "suite.calendar.createEvent",
  calendarUpdateEvent: "suite.calendar.updateEvent",
  calendarDeleteEvent: "suite.calendar.deleteEvent",
  calendarRespond: "suite.calendar.respond",
  calendarRestoreEvent: "suite.calendar.restoreEvent",
  calendarApplyChanges: "suite.calendar.applyChanges",
  calendarUpdateCalendar: "suite.calendar.updateCalendar",
  calendarUpdatePreferences: "suite.calendar.updatePreferences",
  calendarSync: "suite.calendar.sync",
  calendarRemoveAccount: "suite.calendar.removeAccount",
  calendarAddDemo: "suite.calendar.addDemo",
  calendarGoogleConnect: "suite.calendar.google.connect",
  calendarGoogleConnectComplete: "suite.calendar.google.connectComplete",
  calendarGoogleSetClient: "suite.calendar.google.setClient",
  calendarGoogleClearClient: "suite.calendar.google.clearClient",
} as const;

const M = SUITE_CALENDAR_METHODS;

/** Streams a client keeps open: a snapshot, then changes. */
export type SuiteCalendarSubscriptionRpcTag =
  | typeof M.calendarSubscribeDirectory
  | typeof M.calendarSubscribeWeek;
/** Streams that run one command to its end. */
export type SuiteCalendarStreamCommandRpcTag = typeof M.calendarGoogleConnect;
const CalendarRpcError = Schema.Union([CalendarError, EnvironmentAuthorizationError]);

export const SuiteCalendarRpcGroup = RpcGroup.make(
  /** Accounts, calendars, preferences and the Google client state: a snapshot on every change. */
  Rpc.make(M.calendarSubscribeDirectory, {
    payload: Schema.Struct({}),
    success: CalendarDirectory,
    error: CalendarRpcError,
    stream: true,
  }),
  /** One week chunk of visible instances: a snapshot, then changes. */
  Rpc.make(M.calendarSubscribeWeek, {
    payload: CalendarWeekInput,
    success: CalendarWeekEvent,
    error: CalendarRpcError,
    stream: true,
  }),
  Rpc.make(M.calendarGetEvent, {
    payload: CalendarEventRefInput,
    success: CalendarEventDetails,
    error: CalendarRpcError,
  }),
  Rpc.make(M.calendarSearch, {
    payload: CalendarSearchInput,
    success: CalendarSearchResult,
    error: CalendarRpcError,
  }),
  Rpc.make(M.calendarCreateEvent, {
    payload: CalendarCreateEventInput,
    success: CalendarMutationResult,
    error: CalendarRpcError,
  }),
  Rpc.make(M.calendarUpdateEvent, {
    payload: CalendarUpdateEventInput,
    success: CalendarMutationResult,
    error: CalendarRpcError,
  }),
  Rpc.make(M.calendarDeleteEvent, {
    payload: CalendarDeleteEventInput,
    success: CalendarMutationResult,
    error: CalendarRpcError,
  }),
  Rpc.make(M.calendarRespond, {
    payload: CalendarRespondInput,
    success: CalendarMutationResult,
    error: CalendarRpcError,
  }),
  Rpc.make(M.calendarRestoreEvent, {
    payload: CalendarRestoreEventInput,
    success: CalendarMutationResult,
    error: CalendarRpcError,
  }),
  /** Runs undo (or redo) steps in order; answers with the steps that revert them. */
  Rpc.make(M.calendarApplyChanges, {
    payload: CalendarApplyChangesInput,
    success: CalendarMutationResult,
    error: CalendarRpcError,
  }),
  Rpc.make(M.calendarUpdateCalendar, {
    payload: CalendarUpdateCalendarInput,
    error: CalendarRpcError,
  }),
  Rpc.make(M.calendarUpdatePreferences, {
    payload: CalendarPreferencesPatch,
    error: CalendarRpcError,
  }),
  Rpc.make(M.calendarSync, { payload: CalendarSyncInput, error: CalendarRpcError }),
  Rpc.make(M.calendarRemoveAccount, { payload: CalendarAccountRefInput, error: CalendarRpcError }),
  Rpc.make(M.calendarAddDemo, { payload: CalendarAddDemoInput, error: CalendarRpcError }),
  /** Starts a Google sign-in and streams its state; ending the stream cancels an open flow. */
  Rpc.make(M.calendarGoogleConnect, {
    payload: GoogleConnectInput,
    success: GoogleConnectState,
    error: CalendarRpcError,
    stream: true,
  }),
  /** Hands the environment the redirect URL a client caught or the user pasted. */
  Rpc.make(M.calendarGoogleConnectComplete, {
    payload: GoogleConnectCompleteInput,
    error: CalendarRpcError,
  }),
  Rpc.make(M.calendarGoogleSetClient, { payload: GoogleClientInput, error: CalendarRpcError }),
  Rpc.make(M.calendarGoogleClearClient, {
    payload: Schema.Struct({}),
    error: CalendarRpcError,
  }),
);

const read = AuthOrchestrationReadScope;
const operate = AuthOrchestrationOperateScope;

export const SuiteCalendarContract = defineSuiteContract({
  group: SuiteCalendarRpcGroup,
  scopes: {
    [M.calendarSubscribeDirectory]: read,
    [M.calendarSubscribeWeek]: read,
    [M.calendarGetEvent]: read,
    [M.calendarSearch]: read,
    [M.calendarCreateEvent]: operate,
    [M.calendarUpdateEvent]: operate,
    [M.calendarDeleteEvent]: operate,
    [M.calendarRespond]: operate,
    [M.calendarRestoreEvent]: operate,
    [M.calendarApplyChanges]: operate,
    [M.calendarUpdateCalendar]: operate,
    [M.calendarUpdatePreferences]: operate,
    [M.calendarSync]: operate,
    [M.calendarRemoveAccount]: operate,
    [M.calendarAddDemo]: operate,
    [M.calendarGoogleConnect]: operate,
    [M.calendarGoogleConnectComplete]: operate,
    [M.calendarGoogleSetClient]: operate,
    [M.calendarGoogleClearClient]: operate,
  },
});
