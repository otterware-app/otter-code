import {
  type CalendarDirectory,
  type CalendarPreferences,
  DEFAULT_CALENDAR_PREFERENCES,
  type EnvironmentId,
} from "@t3tools/contracts";
import { type DayNumber, parseDayNumber, systemTimeZone } from "@t3tools/shared/calendar/time";
import { useLocation } from "@tanstack/react-router";

import { useActiveEnvironmentId } from "../../suite/calendar/upstreamShims/activeEnvironment";
import { useCalendarDirectory } from "../../state/calendar";
import {
  type CalendarViewKind,
  DEFAULT_CALENDAR_VIEW,
  validateCalendarSearch,
} from "./calendarView.logic";
import { useToday } from "./useToday";

export interface CalendarContext {
  readonly environmentId: EnvironmentId | null;
  readonly directory: CalendarDirectory | null;
  readonly isLoading: boolean;
  readonly preferences: CalendarPreferences;
  /** The zone the calendar shows: the preference, else the device's. */
  readonly timeZone: string;
  readonly today: DayNumber;
}

/** The active environment's calendar directory, preferences, zone and today. */
export function useCalendarContext(): CalendarContext {
  const environmentId = useActiveEnvironmentId();
  const { directory, isLoading } = useCalendarDirectory(environmentId);
  const preferences = directory?.preferences ?? DEFAULT_CALENDAR_PREFERENCES;
  const timeZone = preferences.timeZone ?? systemTimeZone();
  const today = useToday(timeZone);
  return { environmentId, directory, isLoading, preferences, timeZone, today };
}

/** The calendar's view and date from the URL (defaults when not on the calendar). */
export function useCalendarLocation(today: DayNumber): {
  readonly view: CalendarViewKind;
  readonly anchor: DayNumber;
  readonly onCalendar: boolean;
} {
  const key = useLocation({
    select: (location) => {
      if (location.pathname !== "/calendar") return "";
      const search = validateCalendarSearch(location.search as Record<string, unknown>);
      return `${search.view ?? DEFAULT_CALENDAR_VIEW}|${search.date ?? ""}`;
    },
  });
  if (key === "") return { view: DEFAULT_CALENDAR_VIEW, anchor: today, onCalendar: false };
  const [view, date] = key.split("|") as [CalendarViewKind, string];
  return {
    view,
    anchor: (date === "" ? null : parseDayNumber(date)) ?? today,
    onCalendar: true,
  };
}
