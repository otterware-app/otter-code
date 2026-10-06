/**
 * A small month for picking a day: the visible range and today are marked, arrows browse
 * months, and the arrow keys move between days. Always six rows, so it never changes height.
 */
import { formatMonthTitle, formatWeekdayName } from "@t3tools/client-runtime/calendar/format";
import {
  type DayNumber,
  addMonths,
  civilDate,
  formatDayNumber,
  startOfMonth,
  startOfWeek,
} from "@t3tools/shared/calendar/time";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

const LONG_DATE = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function MiniMonth({
  anchor,
  today,
  weekStartsOn,
  range,
  onPick,
  label = "Pick a date",
}: {
  /** The day whose month shows first (the calendar's date). */
  anchor: DayNumber;
  today: DayNumber;
  weekStartsOn: number;
  /** The days the calendar shows, highlighted. */
  range: { readonly firstDay: DayNumber; readonly lastDay: DayNumber } | null;
  onPick: (day: DayNumber) => void;
  label?: string;
}) {
  const anchorMonth = startOfMonth(anchor);
  // Browsing resets when the calendar moves to another month.
  const [browse, setBrowse] = useState({ base: anchorMonth, offset: 0 });
  const offset = browse.base === anchorMonth ? browse.offset : 0;
  const month = addMonths(anchorMonth, offset);
  const setOffset = (next: number) => setBrowse({ base: anchorMonth, offset: next });
  const [focusDay, setFocusDay] = useState<DayNumber | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const first = startOfWeek(month, weekStartsOn);
  const days = Array.from({ length: 42 }, (_, index) => first + index);
  const currentMonth = civilDate(month).month;
  const tabDay =
    focusDay !== null && focusDay >= first && focusDay < first + 42
      ? focusDay
      : anchor >= first && anchor < first + 42 && civilDate(anchor).month === currentMonth
        ? anchor
        : month;

  const focus = (day: DayNumber) => {
    if (day < first || day >= first + 42) {
      setOffset(offset + (day < first ? -1 : 1));
    }
    setFocusDay(day);
    requestAnimationFrame(() =>
      gridRef.current
        ?.querySelector<HTMLElement>(`[data-mini-day="${formatDayNumber(day)}"]`)
        ?.focus(),
    );
  };

  return (
    <div className="flex flex-col gap-1 select-none" data-mini-month="">
      <div className="flex items-center justify-between ps-1.5">
        <span className="text-xs font-medium text-foreground">{formatMonthTitle(month)}</span>
        <div className="flex items-center">
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Previous month"
            onClick={() => setOffset(offset - 1)}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Next month"
            onClick={() => setOffset(offset + 1)}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
      <div
        ref={gridRef}
        role="grid"
        aria-label={label}
        className="grid grid-cols-7 text-center text-xs"
        onKeyDown={(event) => {
          const moves: Record<string, number> = {
            ArrowLeft: -1,
            ArrowRight: 1,
            ArrowUp: -7,
            ArrowDown: 7,
          };
          const move = moves[event.key];
          if (move !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            focus(tabDay + move);
          } else if (event.key === "PageUp" || event.key === "PageDown") {
            event.preventDefault();
            event.stopPropagation();
            focus(addMonths(tabDay, event.key === "PageUp" ? -1 : 1));
          }
        }}
      >
        <div role="row" className="contents">
          {days.slice(0, 7).map((day) => (
            <span
              key={day}
              role="columnheader"
              className="flex h-6 items-center justify-center text-muted-foreground"
            >
              {formatWeekdayName(day, "narrow")}
            </span>
          ))}
        </div>
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <div key={row} role="row" className="contents">
            {days.slice(row * 7, row * 7 + 7).map((day) => {
              const inMonth = civilDate(day).month === currentMonth;
              const inRange = range !== null && day >= range.firstDay && day <= range.lastDay;
              const isToday = day === today;
              return (
                <span
                  key={day}
                  role="gridcell"
                  aria-selected={inRange}
                  className="flex justify-center"
                >
                  <button
                    type="button"
                    tabIndex={day === tabDay ? 0 : -1}
                    data-mini-day={formatDayNumber(day)}
                    aria-label={LONG_DATE.format(day * 86_400_000)}
                    aria-current={isToday ? "date" : undefined}
                    className={cn(
                      "flex size-6.5 cursor-pointer items-center justify-center rounded-full tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isToday
                        ? "bg-primary font-semibold text-primary-foreground"
                        : inRange
                          ? "bg-accent text-accent-foreground hover:bg-accent/80"
                          : inMonth
                            ? "text-foreground hover:bg-accent"
                            : "text-muted-foreground/60 hover:bg-accent",
                    )}
                    onFocus={() => setFocusDay(day)}
                    onClick={() => onPick(day)}
                  >
                    {civilDate(day).day}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
