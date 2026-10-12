/**
 * Calendar commands from anywhere (shortcuts, the palette, the sidebar) run through the mounted
 * calendar page, which knows the view, the date and the preferences. From another page they
 * open the calendar first and run once it mounts.
 */
import type { KeybindingCommand } from "@t3tools/contracts";
import type { DayNumber } from "@t3tools/shared/calendar/time";

import type { CalendarViewKind } from "./calendarView.logic";

export type CalendarCommand =
  | Extract<KeybindingCommand, `calendar.${string}`>
  | { readonly goTo: DayNumber; readonly view?: CalendarViewKind };

type Runner = (command: CalendarCommand) => void;

let runner: Runner | null = null;
let queued: CalendarCommand | null = null;

/** The calendar page takes commands while mounted; a queued one runs right away. */
export function registerCalendarPage(run: Runner): () => void {
  runner = run;
  const pending = queued;
  queued = null;
  if (pending !== null) run(pending);
  return () => {
    if (runner === run) runner = null;
  };
}

/**
 * Runs a command on the calendar page, or opens the page (`openCalendar`) and runs it there.
 * Plain navigation commands need no replay: opening the page already shows today.
 */
export function runCalendarCommand(command: CalendarCommand, openCalendar: () => void): void {
  if (runner !== null) {
    runner(command);
    return;
  }
  queued = command === "calendar.today" ? null : command;
  openCalendar();
}
