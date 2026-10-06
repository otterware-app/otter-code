import type { SpanItem } from "@t3tools/client-runtime/calendar/days";
import {
  formatTime,
  formatTimeRange,
  type HourFormat,
} from "@t3tools/client-runtime/calendar/format";
import type { CalendarEventInstance } from "@t3tools/contracts";
import { memo, type CSSProperties } from "react";

import { flag } from "./eventAppearance";

/**
 * Event elements, kept to the fewest nodes that can carry them: the event element and its
 * title span. The time comes from `data-time` through a pseudo-element, resize edges are
 * pseudo-elements the gesture controller hit-tests by offset, and a timed block's layout
 * (one line, two, or with location) comes from `data-size`, computed here from its height
 * rather than with container queries.
 *
 * Props are primitives plus the instance (whose identity the bucket cache keeps while it is
 * unchanged), so memo skips every event an update does not touch. Clicks, keys and drags are
 * handled by the surface through `data-event-key`, never per element.
 */

export interface EventVisualProps {
  readonly color: string;
  readonly readOnly: boolean;
  readonly selected: boolean;
  readonly pending: boolean;
  readonly past: boolean;
  readonly timeZone: string;
  readonly hourFormat: HourFormat;
}

/** How much a timed block shows: one small line, one line, title and time, or all. */
export type BlockSize = "xs" | "sm" | "md" | "lg";

/** The size class for a block drawn `heightPx` tall. */
export function blockSize(heightPx: number): BlockSize {
  if (heightPx < 21) return "xs";
  if (heightPx < 35) return "sm";
  if (heightPx < 50) return "md";
  return "lg";
}

function title(instance: CalendarEventInstance): string {
  return instance.title || "(No title)";
}

function responseAttribute(instance: CalendarEventInstance): string | undefined {
  return instance.response === undefined || instance.response === "accepted"
    ? undefined
    : instance.response;
}

function responseSuffix(instance: CalendarEventInstance): string {
  switch (instance.response) {
    case "declined":
      return ", declined";
    case "tentative":
      return ", maybe";
    case "needsAction":
      return ", not answered";
    default:
      return instance.tentative === true ? ", tentative" : "";
  }
}

/** A timed event in a day column, placed by minutes (CSS scales with `--hour-height`). */
export const TimedEventBlock = memo(function TimedEventBlock({
  instance,
  eventKey,
  startMinutes,
  endMinutes,
  left,
  width,
  zIndex,
  continuesBefore,
  continuesAfter,
  size,
  narrow,
  dayLabel,
  color,
  readOnly,
  selected,
  pending,
  past,
  timeZone,
  hourFormat,
}: EventVisualProps & {
  readonly instance: CalendarEventInstance;
  readonly eventKey: string;
  readonly startMinutes: number;
  readonly endMinutes: number;
  /** Fractions of the column width. */
  readonly left: number;
  readonly width: number;
  readonly zIndex: number;
  readonly continuesBefore: boolean;
  readonly continuesAfter: boolean;
  readonly size: BlockSize;
  /** Too narrow for more than the title. */
  readonly narrow: boolean;
  readonly dayLabel: string;
}) {
  const time = formatTimeRange(instance.start, instance.end, timeZone, hourFormat);
  const location = size === "lg" && !narrow ? instance.location : undefined;
  return (
    <div
      data-calendar-event=""
      data-timed=""
      data-event-key={eventKey}
      data-size={size}
      data-narrow={flag(narrow)}
      data-time={time}
      data-response={responseAttribute(instance)}
      data-tentative={flag(instance.tentative === true)}
      data-free={flag(instance.free === true)}
      data-past={flag(past)}
      data-selected={flag(selected)}
      data-pending={flag(pending)}
      data-readonly={flag(readOnly)}
      data-continues-before={flag(continuesBefore)}
      data-continues-after={flag(continuesAfter)}
      role="button"
      tabIndex={-1}
      aria-label={`${title(instance)}, ${dayLabel}, ${time}${instance.location ? `, ${instance.location}` : ""}${responseSuffix(instance)}`}
      style={
        {
          // A 1 px gap on every side separates neighbours without a ring or shadow.
          top: `calc(var(--hour-height) * ${startMinutes / 60} + 1px)`,
          height: `calc(var(--hour-height) * ${(endMinutes - startMinutes) / 60} - 2px)`,
          left: `${left * 100}%`,
          width: `calc(${width * 100}% - 2px)`,
          zIndex,
          "--event-color": color,
        } as CSSProperties
      }
    >
      <span data-event-title="">{title(instance)}</span>
      {location ? <span data-event-location="">{location}</span> : null}
    </div>
  );
});

/**
 * Horizontal position of a span within a lane of `columns` days, and its level. Levels stack
 * by `--cal-bar-height` plus `--cal-bar-gap`.
 */
function spanStyle(item: SpanItem, level: number, columns: number, color: string): CSSProperties {
  const days = item.endIndex - item.startIndex + 1;
  return {
    left: `calc(${(item.startIndex / columns) * 100}% + 2px)`,
    width: `calc(${(days / columns) * 100}% - 4px)`,
    top: `calc(${level} * (var(--cal-bar-height) + var(--cal-bar-gap)))`,
    "--event-color": color,
  } as CSSProperties;
}

/** An all-day or multi-day event in the all-day lane or a month week row. */
export const EventBar = memo(function EventBar({
  item,
  level,
  columns,
  color,
  readOnly,
  selected,
  pending,
  past,
  timeZone,
  hourFormat,
}: EventVisualProps & {
  readonly item: SpanItem;
  readonly level: number;
  readonly columns: number;
}) {
  const { instance } = item;
  const time =
    item.kind === "allDay" || item.continuesBefore
      ? undefined
      : formatTime(instance.start, timeZone, hourFormat);
  return (
    <div
      data-calendar-event=""
      data-bar=""
      data-event-key={item.key}
      data-all-day={flag(item.kind === "allDay")}
      data-time={time}
      data-response={responseAttribute(instance)}
      data-tentative={flag(instance.tentative === true)}
      data-free={flag(instance.free === true)}
      data-past={flag(past)}
      data-selected={flag(selected)}
      data-pending={flag(pending)}
      data-readonly={flag(readOnly)}
      data-continues-before={flag(item.continuesBefore)}
      data-continues-after={flag(item.continuesAfter)}
      role="button"
      tabIndex={-1}
      aria-label={`${title(instance)}, ${time ?? "all day"}${responseSuffix(instance)}`}
      style={spanStyle(item, level, columns, color)}
    >
      <span data-event-title="">{title(instance)}</span>
    </div>
  );
});

/** A single-day timed event in a month cell: a dot, its start time and its title. */
export const EventChip = memo(function EventChip({
  item,
  level,
  columns,
  color,
  readOnly,
  selected,
  pending,
  past,
  timeZone,
  hourFormat,
}: EventVisualProps & {
  readonly item: SpanItem;
  readonly level: number;
  readonly columns: number;
}) {
  const { instance } = item;
  const time = formatTime(instance.start, timeZone, hourFormat);
  return (
    <div
      data-calendar-event=""
      data-chip=""
      data-event-key={item.key}
      data-time={time}
      data-response={responseAttribute(instance)}
      data-tentative={flag(instance.tentative === true)}
      data-past={flag(past)}
      data-selected={flag(selected)}
      data-pending={flag(pending)}
      data-readonly={flag(readOnly)}
      role="button"
      tabIndex={-1}
      aria-label={`${title(instance)}, ${time}${responseSuffix(instance)}`}
      style={spanStyle(item, level, columns, color)}
    >
      <span data-event-title="">{title(instance)}</span>
    </div>
  );
});
