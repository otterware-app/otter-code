/** Hands the page's data to the engine view for the current range. */
import type { Calendar, CalendarEventInstance, CalendarPreferences } from "@t3tools/contracts";
import { type DayNumber, civilDate } from "@t3tools/shared/calendar/time";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { runCalendarCommand } from "./calendarCommands";
import type { CalendarRange } from "./calendarView.logic";
import { AgendaList } from "./engine/AgendaList";
import { MonthGrid } from "./engine/MonthGrid";
import { TimeGrid } from "./engine/TimeGrid";
import type { CalendarDraft, CalendarEventChange } from "./engine/types";

export function CalendarViews({
  range,
  instances,
  calendars,
  timeZone,
  preferences,
  today,
  selectedKey,
  pendingKeys,
  onOpenEvent,
  onCreate,
  onChangeEvent,
  onRangeNeeded,
}: {
  range: CalendarRange;
  instances: ReadonlyArray<CalendarEventInstance>;
  calendars: ReadonlyMap<string, Calendar>;
  timeZone: string;
  preferences: CalendarPreferences;
  today: DayNumber;
  selectedKey: string | null;
  pendingKeys: ReadonlySet<string>;
  onOpenEvent: (instance: CalendarEventInstance, anchor: HTMLElement) => void;
  onCreate: (draft: CalendarDraft) => void;
  onChangeEvent: (change: CalendarEventChange) => void;
  onRangeNeeded: (fromDay: DayNumber, toDay: DayNumber) => void;
}) {
  const navigate = useNavigate();
  const openDay = useCallback(
    (day: DayNumber) =>
      runCalendarCommand({ goTo: day, view: "day" }, () => void navigate({ to: "/calendar" })),
    [navigate],
  );
  const common = {
    instances,
    calendars,
    timeZone,
    preferences,
    today,
    selectedKey,
    pendingKeys,
    onOpenEvent,
  };
  switch (range.view) {
    case "day":
    case "week":
    case "custom":
      return (
        <TimeGrid
          {...common}
          days={range.days}
          onCreate={onCreate}
          onChangeEvent={onChangeEvent}
          onOpenDay={openDay}
        />
      );
    case "month":
      return (
        <MonthGrid
          {...common}
          weeks={range.weeks}
          month={civilDate(range.anchor).month}
          onCreate={onCreate}
          onChangeEvent={onChangeEvent}
          onOpenDay={openDay}
          onShowMore={openDay}
        />
      );
    case "agenda":
      return (
        <AgendaList
          {...common}
          anchorDay={range.anchor}
          onNeedRange={onRangeNeeded}
          onOpenDay={openDay}
        />
      );
  }
}
