/**
 * Props of the calendar views (`TimeGrid`, `MonthGrid`, `AgendaList`). The views are
 * data-agnostic: the page hands them the merged, filtered instances and gets user intents back
 * through callbacks. They never mutate data or talk to the server themselves.
 *
 * Times in callbacks follow the contract: timed results are instants (epoch ms) computed from
 * wall-clock times in `timeZone`; all-day results are UTC-midnight dates with an exclusive end.
 */
import type { Calendar, CalendarEventInstance, CalendarPreferences } from "@t3tools/contracts";
import type { DayNumber } from "@t3tools/shared/calendar/time";

/** A new event the user drew or clicked. */
export interface CalendarDraft {
  readonly start: number;
  readonly end: number;
  readonly allDay: boolean;
}

/** A move, resize or duplicate the user finished (drag, or keyboard nudges after a pause). */
export interface CalendarEventChange {
  readonly instance: CalendarEventInstance;
  readonly start: number;
  readonly end: number;
  readonly allDay: boolean;
  /** Alt/Option was held: create a copy at the new time instead of moving. */
  readonly duplicate?: boolean;
}

export interface EngineCommonProps {
  /** Instances to show, already merged across chunks and filtered to visible calendars. */
  readonly instances: ReadonlyArray<CalendarEventInstance>;
  /** Calendars by `calendarId`, for colors and read-only access. */
  readonly calendars: ReadonlyMap<string, Calendar>;
  /** The zone the views are drawn in. */
  readonly timeZone: string;
  /** Uses weekStartsOn, workingHours, hourFormat, defaultEventMinutes and showDeclined. */
  readonly preferences: CalendarPreferences;
  /** Today in `timeZone`. */
  readonly today: DayNumber;
  /** `calendarEventKey` of the selected event, drawn with a ring. */
  readonly selectedKey: string | null;
  /** Keys with an optimistic change in flight, drawn subdued. */
  readonly pendingKeys?: ReadonlySet<string>;
  /** Click, Enter or Space on an event. `anchor` is the element to position a popover at. */
  onOpenEvent(instance: CalendarEventInstance, anchor: HTMLElement): void;
  /**
   * A click on empty space (a default-length slot at the snapped time) or a drawn range.
   * `anchor` locates the new slot on screen for an editor popover.
   */
  onCreate(draft: CalendarDraft, anchor?: HTMLElement | DOMRect): void;
  /** A finished move, resize or duplicate. Called once per gesture. */
  onChangeEvent(change: CalendarEventChange): void;
}

export interface TimeGridProps extends EngineCommonProps {
  /** Visible days, ascending (1 for day view, 7 for a week, N for custom). */
  readonly days: ReadonlyArray<DayNumber>;
  /** Minutes gestures snap to. Defaults to 15. */
  readonly snapMinutes?: number;
  /** Pixels per hour (zoom). Defaults to 48. Exposed as the `--hour-height` CSS variable. */
  readonly hourHeight?: number;
  /** A click on a day header, e.g. to open that day. */
  onOpenDay?(day: DayNumber): void;
}

export interface MonthGridProps extends EngineCommonProps {
  /** Week rows of the grid, each 7 days (5 without weekends). */
  readonly weeks: ReadonlyArray<ReadonlyArray<DayNumber>>;
  /** The month shown, 1–12; days of other months are muted. */
  readonly month: number;
  /** A click on a day's number. */
  onOpenDay(day: DayNumber): void;
  /** "+N more" on a day whose events do not fit. */
  onShowMore(day: DayNumber, anchor: HTMLElement): void;
}

export interface AgendaListProps extends Omit<EngineCommonProps, "onCreate" | "onChangeEvent"> {
  /** The day the list starts at; changing it scrolls there. */
  readonly anchorDay: DayNumber;
  /**
   * The list scrolled near the edge of the days it has shown: load instances for
   * [fromDay, toDay] (inclusive). The range only grows while the anchor stays the same.
   */
  onNeedRange(fromDay: DayNumber, toDay: DayNumber): void;
  /** A click on a day heading. */
  onOpenDay?(day: DayNumber): void;
}
