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
 * Groups a module marks search-only (every calendar, say) stay out: Otter Code's palette has no
 * search-only groups.
 */
export function useSuiteCommandPaletteGroups(): ReadonlyArray<CommandPaletteGroup> {
  const pathname = useLocation({ select: (location) => location.pathname });
  const onCalendar = suiteModuleForPath(pathname)?.id === "calendar";
  const calendar = useCalendarPaletteGroups(usePrimaryEnvironmentId());
  return useMemo(
    () =>
      onCalendar ? toPaletteGroups(calendar.filter((group) => group.searchOnly !== true)) : [],
    [calendar, onCalendar],
  );
}
