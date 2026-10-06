/**
 * `suite.calendar.*` RPCs: each decodes its input, calls one `CalendarService` method and is
 * observed like the upstream calendar handlers in Otter Calendar's `ws.ts`.
 */
import { SUITE_CALENDAR_METHODS as M, SuiteCalendarRpcGroup } from "@t3tools/contracts/suite";
import * as Effect from "effect/Effect";

import { CalendarService } from "../../calendar/CalendarService.ts";
import { observeRpcEffect, observeRpcStream } from "../../observability/RpcInstrumentation.ts";

const trace = { "rpc.aggregate": "calendar" } as const;

export const layer = SuiteCalendarRpcGroup.toLayer(
  Effect.gen(function* () {
    const calendar = yield* CalendarService;
    return SuiteCalendarRpcGroup.of({
      [M.calendarSubscribeDirectory]: () =>
        observeRpcStream(M.calendarSubscribeDirectory, calendar.directory, trace),
      [M.calendarSubscribeWeek]: (input) =>
        observeRpcStream(M.calendarSubscribeWeek, calendar.week(input), {
          ...trace,
          "calendar.week": input.week,
        }),
      [M.calendarGetEvent]: (input) =>
        observeRpcEffect(M.calendarGetEvent, calendar.getEvent(input), trace),
      [M.calendarSearch]: (input) =>
        observeRpcEffect(M.calendarSearch, calendar.search(input), trace),
      [M.calendarCreateEvent]: (input) =>
        observeRpcEffect(M.calendarCreateEvent, calendar.createEvent(input), trace),
      [M.calendarUpdateEvent]: (input) =>
        observeRpcEffect(M.calendarUpdateEvent, calendar.updateEvent(input), trace),
      [M.calendarDeleteEvent]: (input) =>
        observeRpcEffect(M.calendarDeleteEvent, calendar.deleteEvent(input), trace),
      [M.calendarRespond]: (input) =>
        observeRpcEffect(M.calendarRespond, calendar.respond(input), trace),
      [M.calendarRestoreEvent]: (input) =>
        observeRpcEffect(M.calendarRestoreEvent, calendar.restoreEvent(input), trace),
      [M.calendarApplyChanges]: (input) =>
        observeRpcEffect(M.calendarApplyChanges, calendar.applyChanges(input), trace),
      [M.calendarUpdateCalendar]: (input) =>
        observeRpcEffect(M.calendarUpdateCalendar, calendar.updateCalendar(input), trace),
      [M.calendarUpdatePreferences]: (input) =>
        observeRpcEffect(M.calendarUpdatePreferences, calendar.updatePreferences(input), trace),
      [M.calendarSync]: (input) => observeRpcEffect(M.calendarSync, calendar.sync(input), trace),
      [M.calendarRemoveAccount]: (input) =>
        observeRpcEffect(M.calendarRemoveAccount, calendar.removeAccount(input.accountId), trace),
      [M.calendarAddDemo]: (input) =>
        observeRpcEffect(M.calendarAddDemo, calendar.addDemo(input), trace),
      [M.calendarGoogleConnect]: (input) =>
        observeRpcStream(M.calendarGoogleConnect, calendar.connect(input), trace),
      [M.calendarGoogleConnectComplete]: (input) =>
        observeRpcEffect(M.calendarGoogleConnectComplete, calendar.connectComplete(input), trace),
      [M.calendarGoogleSetClient]: (input) =>
        observeRpcEffect(M.calendarGoogleSetClient, calendar.setClient(input), trace),
      [M.calendarGoogleClearClient]: () =>
        observeRpcEffect(M.calendarGoogleClearClient, calendar.clearClient, trace),
    });
  }),
);
