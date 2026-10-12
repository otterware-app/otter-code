/**
 * Otter Calendar's keybinding commands, joined into `STATIC_KEYBINDING_COMMANDS` (one line in
 * `../keybindings.ts`) so the vendored calendar UI can name them. Their default keys apply on the
 * calendar page only and live in the web app (`apps/web/src/suite/calendar/calendarKeybindings.ts`),
 * not in the server's defaults: those are written into the shared `keybindings.json`.
 */
export const CALENDAR_KEYBINDING_COMMANDS = [
  "calendar.today",
  "calendar.next",
  "calendar.previous",
  "calendar.view.day",
  "calendar.view.week",
  "calendar.view.month",
  "calendar.view.agenda",
  "calendar.view.custom",
  "calendar.create",
  "calendar.search",
  "calendar.goToDate",
  "calendar.undo",
  "calendar.redo",
] as const;
