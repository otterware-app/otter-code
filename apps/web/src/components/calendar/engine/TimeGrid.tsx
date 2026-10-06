import "./engine.css";

import {
  DayBucketCache,
  type SpanItem,
  type TimedSegment,
} from "@t3tools/client-runtime/calendar/days";
import {
  formatDayHeader,
  formatHourLabel,
  formatShortDate,
  formatZoneName,
  type HourFormat,
} from "@t3tools/client-runtime/calendar/format";
import { layoutDayCached, packLevels } from "@t3tools/client-runtime/calendar/layout";
import type { Calendar, CalendarEventInstance } from "@t3tools/contracts";
import { type DayNumber, toZoned, weekday } from "@t3tools/shared/calendar/time";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";

import { EventBar, TimedEventBlock, blockSize } from "./EventViews";
import { EMPTY_KEYS, eventColor, isEventReadOnly } from "./eventAppearance";
import { TimeGridController, type TimeGridModel } from "./timeGridController";
import type { TimeGridProps } from "./types";
import { useMinuteClock } from "./useMinuteClock";

const HOURS = Array.from({ length: 23 }, (_, index) => index + 1);
/** Smallest block height in px (engine.css `--event-min-height`). */
const MIN_BLOCK_PX = 18;
/** Timed ghost pool: one interchangeable slot per visible day (custom views show up to 14). */
const GHOST_SLOTS = Array.from({ length: 14 }, (_, index) => `ghost-${index}`);
/** Levels the all-day lane shows before "+N more" (the last one holds the links). */
const COLLAPSED_LANE_LEVELS = 3;

/**
 * Day, week and custom N-day views: a sticky header with day names and the all-day lane, and a
 * scrolling grid of hour rows with one column per day.
 *
 * Rendering stays proportional to what changed: buckets are cached per day, each column is
 * memoized on its bucket and laid out once per bucket identity, and events are positioned with
 * CSS from minutes and `--hour-height`. Gestures run in `TimeGridController` without renders.
 */
export function TimeGrid(props: TimeGridProps) {
  const {
    days,
    instances,
    calendars,
    timeZone,
    preferences,
    today,
    selectedKey,
    pendingKeys = EMPTY_KEYS,
    snapMinutes = 15,
    hourHeight = 48,
    onOpenDay,
  } = props;
  const hourFormat = preferences.hourFormat;

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TimeGridController | null>(null);

  const [cache] = useState(() => new DayBucketCache());
  const buckets = useMemo(
    () => cache.bucket(instances, days, timeZone, preferences.showDeclined),
    [cache, instances, days, timeZone, preferences.showDeclined],
  );
  const shown = useMemo(() => {
    const map = new Map<string, CalendarEventInstance>();
    for (const bucket of buckets.timed)
      for (const segment of bucket) map.set(segment.key, segment.instance);
    for (const span of buckets.spans) map.set(span.key, span.instance);
    return map;
  }, [buckets]);

  const now = useMinuteClock();
  const nowMinutes = toZoned(now, timeZone).minutes;
  const gridColumns = { gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` };

  // Per column, only the selection and pending keys that concern it, so the rest stay memoized.
  const columnState = useMemo(
    () =>
      buckets.timed.map((segments) => ({
        selectedKey:
          selectedKey !== null && segments.some((segment) => segment.key === selectedKey)
            ? selectedKey
            : null,
        pendingKeys:
          pendingKeys.size > 0 && segments.some((segment) => pendingKeys.has(segment.key))
            ? pendingKeys
            : EMPTY_KEYS,
      })),
    [buckets, selectedKey, pendingKeys],
  );

  const model: TimeGridModel = {
    days,
    timeZone,
    snapMinutes,
    hourHeight,
    preferences,
    calendars,
    instances: shown,
    selectedKey,
    onOpenEvent: props.onOpenEvent,
    onCreate: props.onCreate,
    onChangeEvent: props.onChangeEvent,
  };
  const modelRef = useRef(model);
  useLayoutEffect(() => {
    modelRef.current = model;
    controllerRef.current?.afterRender();
  });

  useEffect(() => {
    const elements = {
      root: rootRef.current,
      scroll: scrollRef.current,
      header: headerRef.current,
      columns: columnsRef.current,
      lane: laneRef.current,
      live: liveRef.current,
    };
    if (Object.values(elements).some((element) => element === null)) return;
    const controller = new TimeGridController(
      elements as { [K in keyof typeof elements]: HTMLDivElement },
      () => modelRef.current,
    );
    controllerRef.current = controller;
    controller.afterRender();
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  // On mount, show the working day, or the current time when it is outside working hours.
  const [initialScrollTop] = useState(() => {
    const { start, end } = preferences.workingHours;
    const target =
      days.includes(today) && (nowMinutes < start || nowMinutes > end)
        ? nowMinutes - 120
        : start - 30;
    return Math.max(0, (target / 60) * hourHeight);
  });
  useLayoutEffect(() => {
    if (scrollRef.current !== null) scrollRef.current.scrollTop = initialScrollTop;
  }, [initialScrollTop]);

  return (
    <div
      ref={rootRef}
      data-calendar-surface="timegrid"
      className="relative flex h-full min-h-0 flex-col bg-background"
      style={{ "--hour-height": `${hourHeight}px` } as CSSProperties}
    >
      <div
        ref={scrollRef}
        data-calendar-scroll=""
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div ref={headerRef} data-calendar-header="" className="sticky top-0 z-40 bg-background">
          <div className="flex border-b border-border">
            <div className="flex w-14 shrink-0 items-end justify-end pe-2 pb-1.5 text-3xs text-muted-foreground">
              {formatZoneName(timeZone, now)}
            </div>
            <div className="grid min-w-0 flex-1" style={gridColumns}>
              {days.map((day) => (
                <DayHeader
                  key={day}
                  day={day}
                  isToday={day === today}
                  isPast={day < today}
                  onOpenDay={onOpenDay}
                />
              ))}
            </div>
          </div>
          <AllDayLane
            laneRef={laneRef}
            days={days}
            spans={buckets.spans}
            calendars={calendars}
            timeZone={timeZone}
            hourFormat={hourFormat}
            today={today}
            now={now}
            selectedKey={selectedKey}
            pendingKeys={pendingKeys}
          />
        </div>
        <div className="relative flex" style={{ height: "calc(var(--hour-height) * 24)" }}>
          <TimeGutter hourFormat={hourFormat} />
          <div
            ref={columnsRef}
            data-calendar-columns=""
            className="relative isolate grid min-w-0 flex-1"
            style={gridColumns}
          >
            {days.map((day, index) => (
              <TimeGridColumn
                key={day}
                day={day}
                index={index}
                segments={buckets.timed[index]!}
                hourHeight={hourHeight}
                pastUntil={day < today ? 1440 : day === today ? nowMinutes : 0}
                workStart={workingBound(preferences.workingHours, day, "start")}
                workEnd={workingBound(preferences.workingHours, day, "end")}
                selectedKey={columnState[index]!.selectedKey}
                pendingKeys={columnState[index]!.pendingKeys}
                calendars={calendars}
                timeZone={timeZone}
                hourFormat={hourFormat}
              />
            ))}
            {days.map((day, index) =>
              day === today ? (
                <NowLine key="now" index={index} count={days.length} minutes={nowMinutes} />
              ) : null,
            )}
            {GHOST_SLOTS.slice(0, days.length).map((slot) => (
              <div key={slot} data-calendar-ghost="timed">
                <span className="block truncate" />
                <span className="block truncate font-normal" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div data-gesture-shield="" aria-hidden />
      <div ref={liveRef} aria-live="polite" className="sr-only" />
    </div>
  );
}

function workingBound(
  hours: TimeGridProps["preferences"]["workingHours"],
  day: DayNumber,
  edge: "start" | "end",
): number {
  // Non-working days shade the whole column.
  if (!hours.days.includes(weekday(day))) return 24;
  return (edge === "start" ? hours.start : hours.end) / 60;
}

const DayHeader = memo(function DayHeader({
  day,
  isToday,
  isPast,
  onOpenDay,
}: {
  day: DayNumber;
  isToday: boolean;
  isPast: boolean;
  onOpenDay: ((day: DayNumber) => void) | undefined;
}) {
  const { weekday: name, date } = formatDayHeader(day);
  return (
    <button
      type="button"
      data-no-drag=""
      data-day-header={day}
      aria-current={isToday ? "date" : undefined}
      disabled={onOpenDay === undefined}
      onClick={() => onOpenDay?.(day)}
      className={cn(
        "flex h-10 min-w-0 items-center justify-center gap-1.5 border-s border-border text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset enabled:cursor-pointer enabled:hover:bg-accent/60",
        isPast ? "text-muted-foreground" : "text-foreground",
      )}
    >
      <span className="truncate text-xs text-muted-foreground">{name}</span>
      <span
        className={cn(
          "flex h-6 min-w-6 items-center justify-center rounded-full px-1 font-medium tabular-nums",
          isToday && "bg-primary text-primary-foreground",
        )}
      >
        {date}
      </span>
    </button>
  );
});

const TimeGutter = memo(function TimeGutter({ hourFormat }: { hourFormat: HourFormat }) {
  return (
    <div className="relative w-14 shrink-0" aria-hidden>
      {HOURS.map((hour) => (
        <span
          key={hour}
          className="absolute end-2 -translate-y-1/2 text-2xs text-muted-foreground tabular-nums"
          style={{ top: `calc(var(--hour-height) * ${hour})` }}
        >
          {formatHourLabel(hour, hourFormat)}
        </span>
      ))}
    </div>
  );
});

const TimeGridColumn = memo(function TimeGridColumn({
  day,
  index,
  segments,
  hourHeight,
  pastUntil,
  workStart,
  workEnd,
  selectedKey,
  pendingKeys,
  calendars,
  timeZone,
  hourFormat,
}: {
  day: DayNumber;
  index: number;
  segments: ReadonlyArray<TimedSegment>;
  hourHeight: number;
  /** Events ending at or before this minute of the day are past (0 none, 1440 all). */
  pastUntil: number;
  workStart: number;
  workEnd: number;
  selectedKey: string | null;
  pendingKeys: ReadonlySet<string>;
  calendars: ReadonlyMap<string, Calendar>;
  timeZone: string;
  hourFormat: HourFormat;
}) {
  // Short blocks are drawn at a minimum height; pack them as if they lasted that long.
  const minVisualMinutes = Math.ceil(((MIN_BLOCK_PX / hourHeight) * 60) / 5) * 5;
  const placements = layoutDayCached(segments, { minVisualMinutes, cascade: true });
  const dayLabel = formatShortDate(day);
  const pxPerMinute = hourHeight / 60;
  return (
    <div
      data-calendar-column=""
      data-day={day}
      data-day-index={index}
      style={{ "--work-start": workStart, "--work-end": workEnd } as CSSProperties}
    >
      <div className="absolute inset-y-0 start-0 end-2">
        {placements.map(({ segment, left, width, zIndex }) => {
          const { instance, key, startMinutes, endMinutes } = segment;
          return (
            <TimedEventBlock
              key={key}
              instance={instance}
              eventKey={key}
              startMinutes={startMinutes}
              endMinutes={endMinutes}
              left={left}
              width={width}
              zIndex={zIndex}
              continuesBefore={segment.continuesBefore}
              continuesAfter={segment.continuesAfter}
              size={blockSize(
                Math.max(MIN_BLOCK_PX, (endMinutes - startMinutes) * pxPerMinute - 2),
              )}
              narrow={width <= 0.25}
              dayLabel={dayLabel}
              color={eventColor(instance, calendars)}
              readOnly={isEventReadOnly(instance, calendars)}
              selected={key === selectedKey}
              pending={pendingKeys.has(key)}
              past={endMinutes <= pastUntil}
              timeZone={timeZone}
              hourFormat={hourFormat}
            />
          );
        })}
      </div>
    </div>
  );
});

function NowLine({ index, count, minutes }: { index: number; count: number; minutes: number }) {
  return (
    <div
      data-calendar-now=""
      style={{
        top: `calc(var(--hour-height) * ${minutes / 60})`,
        left: `${(index / count) * 100}%`,
        width: `${100 / count}%`,
      }}
    />
  );
}

const AllDayLane = memo(function AllDayLane({
  laneRef,
  days,
  spans,
  calendars,
  timeZone,
  hourFormat,
  today,
  now,
  selectedKey,
  pendingKeys,
}: {
  laneRef: RefObject<HTMLDivElement | null>;
  days: ReadonlyArray<DayNumber>;
  spans: ReadonlyArray<SpanItem>;
  calendars: ReadonlyMap<string, Calendar>;
  timeZone: string;
  hourFormat: HourFormat;
  today: DayNumber;
  now: number;
  selectedKey: string | null;
  pendingKeys: ReadonlySet<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const layout = useMemo(
    () =>
      packLevels(spans, days.length, expanded ? Number.POSITIVE_INFINITY : COLLAPSED_LANE_LEVELS),
    [spans, days.length, expanded],
  );
  const rows = Math.max(1, layout.rows);
  const canCollapse = layout.totalLevels > COLLAPSED_LANE_LEVELS;
  return (
    <div data-calendar-allday="" className="flex border-b border-border">
      <div className="flex w-14 shrink-0 flex-col items-end gap-0.5 pe-2 pt-1 text-3xs text-muted-foreground">
        <span>All day</span>
        {canCollapse ? (
          <button
            type="button"
            data-no-drag=""
            aria-label={expanded ? "Show fewer all-day events" : "Show all all-day events"}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="flex size-5 cursor-pointer items-center justify-center rounded-sm hover:bg-accent hover:text-foreground"
          >
            {expanded ? (
              <ChevronUpIcon className="size-3.5" />
            ) : (
              <ChevronDownIcon className="size-3.5" />
            )}
          </button>
        ) : null}
      </div>
      <div
        ref={laneRef}
        data-lane-days=""
        className="relative grid min-w-0 flex-1"
        style={{
          gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
          height: `calc(${rows} * (var(--cal-bar-height) + var(--cal-bar-gap)) + 6px)`,
        }}
      >
        {days.map((day) => (
          <div key={day} data-lane-day={day} className="border-s border-border" />
        ))}
        <div className="pointer-events-none absolute inset-x-0 top-0.5 bottom-0 *:pointer-events-auto">
          {layout.placements.map(({ item, level }) => (
            <EventBar
              key={item.key}
              item={item}
              level={level}
              columns={days.length}
              color={eventColor(item.instance, calendars)}
              readOnly={isEventReadOnly(item.instance, calendars)}
              selected={item.key === selectedKey}
              pending={pendingKeys.has(item.key)}
              past={spanIsPast(item, days, today, now)}
              timeZone={timeZone}
              hourFormat={hourFormat}
            />
          ))}
          {layout.truncated
            ? layout.hiddenPerDay.map((count, index) =>
                count > 0 ? (
                  <button
                    key={days[index]}
                    type="button"
                    data-no-drag=""
                    onClick={() => setExpanded(true)}
                    className="absolute cursor-pointer truncate rounded-sm px-1.5 text-start text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    style={{
                      left: `calc(${(index / days.length) * 100}% + 2px)`,
                      width: `calc(${100 / days.length}% - 4px)`,
                      top: `calc(${layout.rows - 1} * (var(--cal-bar-height) + var(--cal-bar-gap)))`,
                      height: "var(--cal-bar-height)",
                    }}
                  >
                    {`+${count} more`}
                  </button>
                ) : null,
              )
            : null}
        </div>
        <div data-calendar-ghost="allday" style={{ height: "var(--cal-bar-height)", top: 2 }}>
          <span className="me-1.5" />
          <span className="font-normal text-muted-foreground" />
        </div>
      </div>
    </div>
  );
});

function spanIsPast(
  item: SpanItem,
  days: ReadonlyArray<DayNumber>,
  today: DayNumber,
  now: number,
): boolean {
  if (item.continuesAfter) return false;
  if (item.kind === "allDay") return days[item.endIndex]! < today;
  return item.instance.end <= now;
}
