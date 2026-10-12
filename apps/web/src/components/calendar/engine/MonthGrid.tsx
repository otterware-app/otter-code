import "./engine.css";

import {
  DayBucketCache,
  type DayBuckets,
  type SpanItem,
  reuseSpans,
  sliceSpans,
} from "@t3tools/client-runtime/calendar/days";
import {
  formatMonthCellDate,
  formatWeekdayName,
  type HourFormat,
} from "@t3tools/client-runtime/calendar/format";
import { packLevels } from "@t3tools/client-runtime/calendar/layout";
import type { Calendar, CalendarEventInstance } from "@t3tools/contracts";
import { type DayNumber, civilDate } from "@t3tools/shared/calendar/time";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { cn } from "~/lib/utils";

import { EventBar, EventChip } from "./EventViews";
import { EMPTY_KEYS, eventColor, flag, isEventReadOnly } from "./eventAppearance";
import { MONTH_DAY_HEADER_PX, MonthController, type MonthModel } from "./monthController";
import type { MonthGridProps } from "./types";
import { useMinuteClock } from "./useMinuteClock";

/** Ghost pool: one interchangeable bar per week row. */
const GHOST_SLOTS = ["ghost-0", "ghost-1", "ghost-2", "ghost-3", "ghost-4", "ghost-5"];
/** Bar height plus gap, px (engine.css `--cal-bar-height` + `--cal-bar-gap`). */
const LEVEL_PX = 22;

/**
 * Items of each week row: multi-day bars clipped to the row, and single-day timed events on
 * the first visible day they touch. Rows whose items did not change keep their array, so their
 * memoized row and level layout survive updates elsewhere.
 */
class RowItemsCache {
  private rows = new Map<DayNumber, ReadonlyArray<SpanItem>>();

  rowItems(buckets: DayBuckets, columns: number): ReadonlyArray<ReadonlyArray<SpanItem>> {
    const seen = new Set<string>();
    const next = new Map<DayNumber, ReadonlyArray<SpanItem>>();
    const result: Array<ReadonlyArray<SpanItem>> = [];
    for (let start = 0; start < buckets.days.length; start += columns) {
      const end = Math.min(buckets.days.length, start + columns);
      const items = sliceSpans(buckets.spans, start, end);
      for (let index = start; index < end; index++) {
        for (const segment of buckets.timed[index]!) {
          if (seen.has(segment.key)) continue;
          seen.add(segment.key);
          items.push({
            key: segment.key,
            instance: segment.instance,
            kind: "timed",
            startIndex: index - start,
            endIndex: index - start,
            continuesBefore: false,
            continuesAfter: false,
          });
        }
      }
      const first = buckets.days[start]!;
      const previous = this.rows.get(first);
      const reused = reuseSpans(previous, items);
      next.set(first, reused);
      result.push(reused);
    }
    this.rows = next;
    return result;
  }
}

/**
 * The month view: week rows filling the height, multi-day bars packed into levels, single-day
 * timed events as compact rows, and "+N more" where a day overflows. How many levels fit comes
 * from one ResizeObserver on the grid; events are never measured.
 */
export function MonthGrid(props: MonthGridProps) {
  const {
    weeks,
    month,
    instances,
    calendars,
    timeZone,
    preferences,
    today,
    selectedKey,
    pendingKeys = EMPTY_KEYS,
  } = props;
  const columns = Math.max(1, weeks[0]?.length ?? 7);
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<MonthController | null>(null);

  const days = useMemo(() => weeks.flat(), [weeks]);
  const [bucketCache] = useState(() => new DayBucketCache());
  const [rowCache] = useState(() => new RowItemsCache());
  const buckets = useMemo(
    () => bucketCache.bucket(instances, days, timeZone, preferences.showDeclined),
    [bucketCache, instances, days, timeZone, preferences.showDeclined],
  );
  const rows = useMemo(() => rowCache.rowItems(buckets, columns), [rowCache, buckets, columns]);
  const shown = useMemo(() => {
    const map = new Map<string, CalendarEventInstance>();
    for (const bucket of buckets.timed)
      for (const segment of bucket) map.set(segment.key, segment.instance);
    for (const span of buckets.spans) map.set(span.key, span.instance);
    return map;
  }, [buckets]);

  const [maxLevels, setMaxLevels] = useState(3);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (grid === null) return;
    const update = (height: number) => {
      const cell = height / Math.max(1, weeks.length);
      const levels = Math.max(1, Math.floor((cell - MONTH_DAY_HEADER_PX - 2) / LEVEL_PX));
      setMaxLevels((current) => (current === levels ? current : levels));
    };
    update(grid.getBoundingClientRect().height);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry !== undefined) update(entry.contentRect.height);
    });
    observer.observe(grid);
    return () => observer.disconnect();
  }, [weeks.length]);

  const now = useMinuteClock();

  const model: MonthModel = {
    days,
    columns,
    timeZone,
    preferences,
    calendars,
    instances: shown,
    selectedKey,
    onOpenEvent: props.onOpenEvent,
    onCreate: props.onCreate,
    onChangeEvent: props.onChangeEvent,
    onOpenDay: props.onOpenDay,
    onShowMore: props.onShowMore,
  };
  const modelRef = useRef(model);
  useLayoutEffect(() => {
    modelRef.current = model;
    controllerRef.current?.afterRender();
  });

  useEffect(() => {
    const root = rootRef.current;
    const grid = gridRef.current;
    const live = liveRef.current;
    if (root === null || grid === null || live === null) return;
    const controller = new MonthController({ root, grid, live }, () => modelRef.current);
    controllerRef.current = controller;
    controller.afterRender();
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const gridColumns = { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` };

  return (
    <div
      ref={rootRef}
      data-calendar-surface="month"
      className="relative flex h-full min-h-0 flex-col bg-background"
    >
      <div className="grid border-b border-border" style={gridColumns}>
        {(weeks[0] ?? []).map((day) => (
          <div key={day} className="truncate px-2 py-1.5 text-end text-xs text-muted-foreground">
            {formatWeekdayName(day)}
          </div>
        ))}
      </div>
      <div
        ref={gridRef}
        className="relative grid min-h-0 flex-1"
        style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}
      >
        {/* Ghosts first, so `last:` below still finds the last week row. */}
        {GHOST_SLOTS.slice(0, weeks.length).map((slot) => (
          <div key={slot} data-calendar-ghost="month">
            <span className="me-1.5" />
            <span className="font-normal text-muted-foreground" />
          </div>
        ))}
        {weeks.map((week, row) => {
          const items = rows[row] ?? [];
          const selected =
            selectedKey !== null && items.some((item) => item.key === selectedKey)
              ? selectedKey
              : null;
          const pending =
            pendingKeys.size > 0 && items.some((item) => pendingKeys.has(item.key))
              ? pendingKeys
              : EMPTY_KEYS;
          // Only the row with today changes every minute; earlier rows are past, later ones not.
          const rowNow = week.includes(today)
            ? now
            : week[0]! > today
              ? 0
              : Number.POSITIVE_INFINITY;
          return (
            <MonthWeekRow
              key={week[0]}
              days={week}
              items={items}
              maxLevels={maxLevels}
              month={month}
              today={today}
              now={rowNow}
              selectedKey={selected}
              pendingKeys={pending}
              calendars={calendars}
              timeZone={timeZone}
              hourFormat={preferences.hourFormat}
            />
          );
        })}
      </div>
      <div data-gesture-shield="" aria-hidden />
      <div ref={liveRef} aria-live="polite" className="sr-only" />
    </div>
  );
}

const MonthWeekRow = memo(function MonthWeekRow({
  days,
  items,
  maxLevels,
  month,
  today,
  now,
  selectedKey,
  pendingKeys,
  calendars,
  timeZone,
  hourFormat,
}: {
  days: ReadonlyArray<DayNumber>;
  items: ReadonlyArray<SpanItem>;
  maxLevels: number;
  month: number;
  today: DayNumber;
  /** Timed events ending by this instant are past: now, or +Infinity / 0 for rows before / after today. */
  now: number;
  selectedKey: string | null;
  pendingKeys: ReadonlySet<string>;
  calendars: ReadonlyMap<string, Calendar>;
  timeZone: string;
  hourFormat: HourFormat;
}) {
  const layout = useMemo(
    () => packLevels(items, days.length, maxLevels),
    [items, days.length, maxLevels],
  );
  const columns = days.length;
  return (
    <div
      data-month-row=""
      className="relative grid min-h-0 border-b border-border last:border-b-0"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {days.map((day) => {
        const { month: dayMonth, day: dom } = civilDate(day);
        const outside = dayMonth !== month;
        return (
          <div
            key={day}
            data-day={day}
            data-outside={flag(outside)}
            className={cn(
              "relative min-w-0 border-s border-border first:border-s-0",
              outside && "bg-muted/60",
            )}
          >
            <div className="flex h-7 items-start justify-end px-1 pt-1">
              <button
                type="button"
                data-no-drag=""
                data-day-number={day}
                aria-label={`Open ${formatMonthCellDate(day, true)}`}
                aria-current={day === today ? "date" : undefined}
                className={cn(
                  "flex h-5 min-w-5 cursor-pointer items-center justify-center rounded-full px-1.5 text-xs tabular-nums outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                  day === today
                    ? "bg-primary font-medium text-primary-foreground hover:bg-primary/90"
                    : outside
                      ? "text-muted-foreground"
                      : "text-foreground",
                )}
              >
                {formatMonthCellDate(day, dom === 1)}
              </button>
            </div>
          </div>
        );
      })}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 *:pointer-events-auto"
        style={{ top: MONTH_DAY_HEADER_PX }}
      >
        {layout.placements.map(({ item, level }) => {
          const visual = {
            color: eventColor(item.instance, calendars),
            readOnly: isEventReadOnly(item.instance, calendars),
            selected: item.key === selectedKey,
            pending: pendingKeys.has(item.key),
            past: isPast(item, days, today, now),
            timeZone,
            hourFormat,
          };
          return item.kind === "timed" ? (
            <EventChip key={item.key} item={item} level={level} columns={columns} {...visual} />
          ) : (
            <EventBar key={item.key} item={item} level={level} columns={columns} {...visual} />
          );
        })}
        {layout.truncated
          ? layout.hiddenPerDay.map((count, index) =>
              count > 0 ? (
                <button
                  key={days[index]}
                  type="button"
                  data-no-drag=""
                  data-more={days[index]}
                  className="absolute cursor-pointer truncate rounded-sm px-1.5 text-start text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                  style={
                    {
                      left: `calc(${(index / columns) * 100}% + 2px)`,
                      width: `calc(${100 / columns}% - 4px)`,
                      top: `calc(${layout.rows - 1} * (var(--cal-bar-height) + var(--cal-bar-gap)))`,
                      height: "var(--cal-bar-height)",
                    } as CSSProperties
                  }
                >
                  {`+${count} more`}
                </button>
              ) : null,
            )
          : null}
      </div>
    </div>
  );
});

function isPast(
  item: SpanItem,
  days: ReadonlyArray<DayNumber>,
  today: DayNumber,
  now: number,
): boolean {
  if (item.continuesAfter) return false;
  if (item.kind === "allDay") return days[item.endIndex]! < today;
  return item.instance.end <= now;
}
