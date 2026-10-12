/** Calendar RPC handlers call the service; the shared group middleware records each request. */
import { SUITE_CALENDAR_METHODS as M, SuiteCalendarRpcGroup } from "@t3tools/contracts/suite";
import * as Effect from "effect/Effect";

import { CalendarService } from "../../calendar/CalendarService.ts";

export const layer = SuiteCalendarRpcGroup.toLayer(
  Effect.gen(function* () {
    const calendar = yield* CalendarService;
    return SuiteCalendarRpcGroup.of({
      [M.calendarSubscribeDirectory]: () => calendar.directory,
      [M.calendarSubscribeWeek]: (input) => calendar.week(input),
      [M.calendarGetEvent]: (input) => calendar.getEvent(input),
      [M.calendarSearch]: (input) => calendar.search(input),
      [M.calendarCreateEvent]: (input) => calendar.createEvent(input),
      [M.calendarUpdateEvent]: (input) => calendar.updateEvent(input),
      [M.calendarDeleteEvent]: (input) => calendar.deleteEvent(input),
      [M.calendarRespond]: (input) => calendar.respond(input),
      [M.calendarRestoreEvent]: (input) => calendar.restoreEvent(input),
      [M.calendarApplyChanges]: (input) => calendar.applyChanges(input),
      [M.calendarUpdateCalendar]: (input) => calendar.updateCalendar(input),
      [M.calendarUpdatePreferences]: (input) => calendar.updatePreferences(input),
      [M.calendarSync]: (input) => calendar.sync(input),
      [M.calendarRemoveAccount]: (input) => calendar.removeAccount(input.accountId),
      [M.calendarAddDemo]: (input) => calendar.addDemo(input),
      [M.calendarGoogleConnect]: (input) => calendar.connect(input),
      [M.calendarGoogleConnectComplete]: (input) => calendar.connectComplete(input),
      [M.calendarGoogleSetClient]: (input) => calendar.setClient(input),
      [M.calendarGoogleClearClient]: () => calendar.clearClient,
    });
  }),
);
