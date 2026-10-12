import { useLocation } from "@tanstack/react-router";
import { useMemo } from "react";

import type { CommandPaletteGroup } from "../components/CommandPalette.logic";
import { useCalendarPaletteGroups } from "../components/calendar/useCalendarPaletteGroups";
import { usePrimaryEnvironmentId } from "../state/environments";
import { toPaletteGroups } from "./calendar/upstreamShims/commandPaletteLogic";
import { suiteModuleForPath } from "./modules";

/**
 * Module entries for the command palette's root (one hook call in `CommandPalette.tsx`), listed
 * while the module's page is open; elsewhere `suiteCommandPaletteItems` offers "Go to <module>".
 * Groups a module marks search-only (individual calendars, say) appear once the user types.
 */
export function useSuiteCommandPaletteGroups(query: string): ReadonlyArray<CommandPaletteGroup> {
  const pathname = useLocation({ select: (location) => location.pathname });
  const onCalendar = suiteModuleForPath(pathname)?.id === "calendar";
  const environmentId = usePrimaryEnvironmentId();
  const calendar = useCalendarPaletteGroups(onCalendar ? environmentId : null);
  return useMemo(
    () => (onCalendar ? toPaletteGroups(calendar, query) : []),
    [calendar, onCalendar, query],
  );
}
