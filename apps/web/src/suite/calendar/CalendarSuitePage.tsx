/**
 * The `/calendar` page: Otter Calendar's vendored page (`components/calendar/CalendarPage`) in
 * the module frame. The calendar sidebar (mini month, calendars) fills the module sidebar, the
 * toolbar the module header, and what the user looks at goes to the side chat.
 */
import { formatLongDate, formatTimeRange } from "@t3tools/client-runtime/calendar/format";
import { calendarEventKey, type CalendarEventInstance } from "@t3tools/contracts";
import { DAY_MS, type DayNumber, formatDayNumber, toZoned } from "@t3tools/shared/calendar/time";
import { useState } from "react";

import { CalendarPage } from "../../components/calendar/CalendarPage";
import { CalendarPromptHost } from "../../components/calendar/CalendarPromptHost";
import { CalendarSidebar } from "../../components/calendar/CalendarSidebar";
import { useCalendarUi } from "../../components/calendar/calendarUiStore";
import type { CalendarViewKind } from "../../components/calendar/calendarView.logic";
import { GoogleConnectDialog } from "../../components/calendar/GoogleConnectDialog";
import { useCalendarContext } from "../../components/calendar/useCalendarContext";
import { SuiteModuleLayout } from "../SuiteModuleLayout";
import { type SuitePageRef, useSuitePageContext } from "../suitePageContext";
import { useCalendarAgentContext } from "./upstreamShims/agentPanelStore";
import { CalendarHeaderSlot } from "./upstreamShims/AppPage";

/** The event the popover or editor shows. */
function useSelectedInstance(): CalendarEventInstance | null {
  return useCalendarUi(
    (state) =>
      state.popover?.instance ?? (state.editor?.mode === "edit" ? state.editor.instance : null),
  );
}

function eventDay(instance: CalendarEventInstance, timeZone: string): DayNumber {
  return instance.allDay === true
    ? Math.floor(instance.start / DAY_MS)
    : toZoned(instance.start, timeZone).day;
}

/** Publishes the visible range, the open event and the shown calendars for the side chat. */
function useCalendarPageContext() {
  const { directory, preferences, timeZone } = useCalendarContext();
  const description = useCalendarAgentContext((state) => state.text);
  const selected = useSelectedInstance();
  const refs: SuitePageRef[] = [];
  if (selected !== null) {
    const day = eventDay(selected, timeZone);
    const when =
      selected.allDay === true
        ? `${formatLongDate(day)}, all day`
        : `${formatLongDate(day)}, ${formatTimeRange(selected.start, selected.end, timeZone, preferences.hourFormat)}`;
    refs.push({
      kind: "calendar.event",
      id: calendarEventKey(selected.calendarId, selected.eventId),
      label: `${selected.title || "(No title)"} (${when})`,
      href: `/calendar?date=${formatDayNumber(day)}`,
    });
  }
  for (const calendar of directory?.calendars ?? []) {
    if (calendar.visible) {
      refs.push({ kind: "calendar.calendar", id: calendar.calendarId, label: calendar.name });
    }
  }
  useSuitePageContext({
    module: "calendar",
    title: description ?? `Calendar, time zone ${timeZone}`,
    refs,
  });
}

function CalendarPageContext() {
  useCalendarPageContext();
  return null;
}

export function CalendarSuitePage(props: {
  readonly view: CalendarViewKind;
  readonly date: DayNumber | null;
  readonly onShow: (
    view: CalendarViewKind,
    date: DayNumber | null,
    options: { replace: boolean },
  ) => void;
}) {
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const { environmentId } = useCalendarContext();
  return (
    <CalendarHeaderSlot.Provider value={headerSlot}>
      <SuiteModuleLayout
        moduleId="calendar"
        sidebar={<CalendarSidebar />}
        headerActions={<div ref={setHeaderSlot} className="flex min-w-0 items-center gap-2" />}
      >
        <CalendarPage view={props.view} date={props.date} onShow={props.onShow} />
        <CalendarPageContext />
      </SuiteModuleLayout>
      <GoogleConnectDialog environmentId={environmentId} />
      <CalendarPromptHost />
    </CalendarHeaderSlot.Provider>
  );
}
