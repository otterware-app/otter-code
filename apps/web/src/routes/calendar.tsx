import { formatDayNumber, parseDayNumber, type DayNumber } from "@t3tools/shared/calendar/time";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import {
  type CalendarViewKind,
  DEFAULT_CALENDAR_VIEW,
  validateCalendarSearch,
} from "../components/calendar/calendarView.logic";
import { CalendarSuitePage } from "../suite/calendar/CalendarSuitePage";
import { requireSuiteRouteAuth } from "../suite/routeGuards";

interface Shown {
  readonly view: CalendarViewKind;
  readonly date: DayNumber | null;
}

const sameShown = (a: Shown, b: Shown) => a.view === b.view && a.date === b.date;

/**
 * Renders the view and date from local state, so paging paints in the frame after the key press
 * instead of after the router resolves the navigation (as Otter Calendar's route does). While
 * our own navigations are in flight the URL is ignored; once they settle, the URL wins again,
 * so back, forward and links keep working.
 */
function CalendarRoute() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const url: Shown = {
    view: search.view ?? DEFAULT_CALENDAR_VIEW,
    date: search.date === undefined ? null : parseDayNumber(search.date),
  };
  const [shown, setShown] = useState<Shown>(url);
  const [pending, setPending] = useState(0);
  const [seen, setSeen] = useState({ url, pending });
  if (!sameShown(seen.url, url) || seen.pending !== pending) {
    setSeen({ url, pending });
    if (pending === 0 && !sameShown(shown, url)) setShown(url);
  }
  const show = useCallback(
    (view: CalendarViewKind, date: DayNumber | null, options: { replace: boolean }) => {
      setShown({ view, date });
      setPending((count) => count + 1);
      void navigate({
        to: "/calendar",
        search: {
          ...(view === DEFAULT_CALENDAR_VIEW ? {} : { view }),
          ...(date === null ? {} : { date: formatDayNumber(date) }),
        },
        replace: options.replace,
      }).finally(() => setPending((count) => count - 1));
    },
    [navigate],
  );
  return <CalendarSuitePage view={shown.view} date={shown.date} onShow={show} />;
}

export const Route = createFileRoute("/calendar")({
  beforeLoad: requireSuiteRouteAuth,
  validateSearch: validateCalendarSearch,
  component: CalendarRoute,
});
