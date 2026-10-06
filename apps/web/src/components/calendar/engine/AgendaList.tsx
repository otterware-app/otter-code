import "./engine.css";

import { bucketInstances, reuseList, sameInstance } from "@t3tools/client-runtime/calendar/days";
import {
  formatRelativeDay,
  formatResponse,
  formatShortDate,
  formatTime,
  formatTimeRange,
  type HourFormat,
} from "@t3tools/client-runtime/calendar/format";
import type { Calendar, CalendarEventInstance } from "@t3tools/contracts";
import { type DayNumber, zonedDay } from "@t3tools/shared/calendar/time";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { EMPTY_KEYS, eventColor, eventColorStyle, flag } from "./eventAppearance";
import { focusNeighbour, syncRovingFocus } from "./keyboard";
import type { AgendaListProps } from "./types";
import { useMinuteClock } from "./useMinuteClock";

/** Days loaded around the anchor at first, and added per step when the list nears an edge. */
const INITIAL_AFTER = 42;
const EXTEND_BY = 28;
/** How far the list may reach from its anchor (about five years each way). */
const MAX_REACH = 1830;

interface AgendaItem {
  readonly key: string;
  readonly instance: CalendarEventInstance;
  /** How the day shows the event's time. */
  readonly when: "allDay" | "range" | "from" | "until";
}

interface AgendaGroup {
  readonly day: DayNumber;
  readonly items: ReadonlyArray<AgendaItem>;
}

function sameItem(a: AgendaItem, b: AgendaItem): boolean {
  return a === b || (a.key === b.key && a.when === b.when && sameInstance(a.instance, b.instance));
}

/**
 * Groups instances by local day for [from, to], keeping only days with events plus `always`
 * (today and the anchor). Groups whose items did not change keep their identity, so rendered
 * days stay memoized when an update lands elsewhere.
 */
class AgendaGroupCache {
  private groups = new Map<DayNumber, AgendaGroup>();
  private list: AgendaGroup[] = [];

  build(
    instances: ReadonlyArray<CalendarEventInstance>,
    from: DayNumber,
    to: DayNumber,
    timeZone: string,
    showDeclined: boolean,
    always: ReadonlyArray<DayNumber>,
  ): AgendaGroup[] {
    const days: DayNumber[] = [];
    for (let day = from; day <= to; day++) days.push(day);
    const buckets = bucketInstances(instances, days, timeZone, showDeclined);
    const perDay: AgendaItem[][] = days.map(() => []);
    for (const span of buckets.spans) {
      const firstDay = span.kind === "allDay" ? null : zonedDay(span.instance.start, timeZone);
      const lastDay =
        span.kind === "allDay"
          ? null
          : zonedDay(Math.max(span.instance.start, span.instance.end - 1), timeZone);
      for (let index = span.startIndex; index <= span.endIndex; index++) {
        const day = days[index]!;
        const when =
          firstDay === null || (day !== firstDay && day !== lastDay)
            ? "allDay"
            : day === firstDay
              ? "from"
              : "until";
        perDay[index]!.push({ key: span.key, instance: span.instance, when });
      }
    }
    buckets.timed.forEach((segments, index) => {
      for (const segment of segments) {
        const when =
          segment.continuesBefore && segment.continuesAfter
            ? "allDay"
            : segment.continuesAfter
              ? "from"
              : segment.continuesBefore
                ? "until"
                : "range";
        perDay[index]!.push({ key: segment.key, instance: segment.instance, when });
      }
    });
    const next = new Map<DayNumber, AgendaGroup>();
    const groups: AgendaGroup[] = [];
    days.forEach((day, index) => {
      const items = perDay[index]!;
      if (items.length === 0 && !always.includes(day)) return;
      const previous = this.groups.get(day);
      const group =
        previous !== undefined && reuseList(previous.items, items, sameItem) === previous.items
          ? previous
          : { day, items };
      next.set(day, group);
      groups.push(group);
    });
    this.groups = next;
    // Same groups in the same order: keep the array, so the list does not see new data (and
    // does not re-fire its edge callbacks) when a range grows without adding events.
    if (
      groups.length !== this.list.length ||
      groups.some((group, index) => group !== this.list[index])
    ) {
      this.list = groups;
    }
    return this.list;
  }
}

/**
 * The schedule: days with events as a virtualized list that loads more days in both directions
 * and keeps its position when earlier days arrive. Changing `anchorDay` starts over there.
 */
export function AgendaList(props: AgendaListProps) {
  return <AgendaListAt key={props.anchorDay} {...props} />;
}

function AgendaListAt(props: AgendaListProps) {
  const {
    anchorDay,
    instances,
    calendars,
    timeZone,
    preferences,
    today,
    selectedKey,
    pendingKeys = EMPTY_KEYS,
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState(() => ({
    from: anchorDay,
    to: anchorDay + INITIAL_AFTER,
  }));
  const [cache] = useState(() => new AgendaGroupCache());
  const groups = useMemo(
    () =>
      cache.build(instances, range.from, range.to, timeZone, preferences.showDeclined, [
        anchorDay,
        today,
      ]),
    [cache, instances, range.from, range.to, timeZone, preferences.showDeclined, anchorDay, today],
  );
  const now = useMinuteClock();
  const listRef = useRef<LegendListRef>(null);

  const shown = useMemo(() => {
    const map = new Map<string, CalendarEventInstance>();
    for (const group of groups) for (const item of group.items) map.set(item.key, item.instance);
    return map;
  }, [groups]);
  // Rows re-render for these only; everything else reaches them through `groups`.
  const extraData = useMemo(
    () => ({ selectedKey, pendingKeys, now, today }),
    [selectedKey, pendingKeys, now, today],
  );

  // The list starts at the anchor day, so it opens there without scrolling to an index whose
  // offset would come from estimated row heights. Earlier days load once the user scrolls up
  // (at the top, a wheel or swipe upward), and the list keeps its position when they arrive.
  const userScrolled = useRef(false);
  const loadEarlier = useCallback(() => {
    setRange((current) =>
      current.from <= anchorDay - MAX_REACH
        ? current
        : { ...current, from: current.from - EXTEND_BY },
    );
  }, [anchorDay]);
  const loadEarlierRef = useRef(loadEarlier);

  const latest = useRef(props);
  const shownRef = useRef(shown);
  const rovingRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    latest.current = props;
    shownRef.current = shown;
    loadEarlierRef.current = loadEarlier;
    if (rootRef.current !== null)
      syncRovingFocus(rootRef.current, rovingRef.current ?? selectedKey);
  });

  // Ask for the days the list covers whenever it grows.
  useEffect(() => {
    latest.current.onNeedRange(range.from, range.to);
  }, [range.from, range.to]);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const eventAt = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>("[data-event-key]") : null;
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const header = target.closest<HTMLElement>("[data-agenda-day]");
      if (header !== null) {
        latest.current.onOpenDay?.(Number(header.dataset.agendaDay));
        return;
      }
      const element = eventAt(target);
      const instance =
        element !== null ? shownRef.current.get(element.dataset.eventKey ?? "") : undefined;
      if (element !== null && instance !== undefined) latest.current.onOpenEvent(instance, element);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const element = eventAt(event.target);
      if (element === null || element !== event.target) return;
      if (event.key === "Enter" || event.key === " ") {
        const instance = shownRef.current.get(element.dataset.eventKey ?? "");
        if (instance === undefined) return;
        event.preventDefault();
        latest.current.onOpenEvent(instance, element);
      } else if (
        (event.key === "ArrowUp" || event.key === "ArrowDown") &&
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey
      ) {
        if (focusNeighbour(root, element, event.key)) event.preventDefault();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const element = eventAt(event.target);
      if (element === null) return;
      rovingRef.current = element.dataset.eventKey ?? null;
      syncRovingFocus(root, rovingRef.current);
    };
    const onUserScroll = () => {
      userScrolled.current = true;
    };
    const onWheel = (event: WheelEvent) => {
      userScrolled.current = true;
      const scroller = listRef.current?.getScrollableNode();
      if (event.deltaY < 0 && scroller instanceof HTMLElement && scroller.scrollTop <= 0) {
        loadEarlierRef.current();
      }
    };
    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKeyDown);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("wheel", onWheel, { passive: true });
    root.addEventListener("touchstart", onUserScroll, { passive: true });
    root.addEventListener("keydown", onUserScroll);
    root.addEventListener("pointerdown", onUserScroll);
    return () => {
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("touchstart", onUserScroll);
      root.removeEventListener("keydown", onUserScroll);
      root.removeEventListener("pointerdown", onUserScroll);
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeyDown);
      root.removeEventListener("focusin", onFocusIn);
    };
  }, []);

  const hourFormat = preferences.hourFormat;
  return (
    <div
      ref={rootRef}
      data-calendar-surface="agenda"
      className="relative flex h-full min-h-0 flex-col bg-background"
    >
      <LegendList<AgendaGroup>
        ref={listRef}
        data={groups}
        keyExtractor={(group) => String(group.day)}
        renderItem={({ item }) => (
          <AgendaDay
            group={item}
            today={today}
            now={item.day === today ? now : item.day < today ? Number.POSITIVE_INFINITY : 0}
            selectedKey={
              selectedKey !== null && item.items.some((entry) => entry.key === selectedKey)
                ? selectedKey
                : null
            }
            pendingKeys={
              pendingKeys.size > 0 && item.items.some((entry) => pendingKeys.has(entry.key))
                ? pendingKeys
                : EMPTY_KEYS
            }
            calendars={calendars}
            timeZone={timeZone}
            hourFormat={hourFormat}
          />
        )}
        extraData={extraData}
        estimatedItemSize={88}
        drawDistance={800}
        maintainVisibleContentPosition
        onStartReachedThreshold={1}
        onEndReachedThreshold={1}
        onStartReached={() => {
          if (userScrolled.current) loadEarlier();
        }}
        onEndReached={() =>
          setRange((current) =>
            current.to >= anchorDay + MAX_REACH
              ? current
              : { ...current, to: current.to + EXTEND_BY },
          )
        }
        className="min-h-0 flex-1 overscroll-contain"
      />
    </div>
  );
}

const WHEN_LABEL: Record<Exclude<AgendaItem["when"], "range">, string> = {
  allDay: "All day",
  from: "From",
  until: "Until",
};

const AgendaDay = memo(function AgendaDay({
  group,
  today,
  now,
  selectedKey,
  pendingKeys,
  calendars,
  timeZone,
  hourFormat,
}: {
  group: AgendaGroup;
  today: DayNumber;
  /** Timed events ending by this instant are past. */
  now: number;
  selectedKey: string | null;
  pendingKeys: ReadonlySet<string>;
  calendars: ReadonlyMap<string, Calendar>;
  timeZone: string;
  hourFormat: HourFormat;
}) {
  const { day, items } = group;
  const isToday = day === today;
  const relative = formatRelativeDay(day, today);
  const date = formatShortDate(day);
  return (
    <section
      className="border-b border-border"
      aria-label={relative === date ? date : `${relative}, ${date}`}
    >
      <button
        type="button"
        data-agenda-day={day}
        className={cn(
          "sticky top-0 z-10 flex w-full cursor-pointer items-baseline gap-2 bg-background px-4 pt-3 pb-1.5 text-start outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          day < today ? "text-muted-foreground" : "text-foreground",
        )}
      >
        <span className={cn("text-sm font-medium", isToday && "text-primary")}>{relative}</span>
        {relative !== date ? <span className="text-xs text-muted-foreground">{date}</span> : null}
      </button>
      {items.length === 0 ? (
        <p className="px-4 pb-3 text-sm text-muted-foreground">No events</p>
      ) : (
        <div className="flex flex-col pb-2">
          {items.map((item) => {
            const { instance } = item;
            const response = formatResponse(instance);
            const time =
              item.when === "range"
                ? formatTimeRange(instance.start, instance.end, timeZone, hourFormat)
                : item.when === "from"
                  ? `${WHEN_LABEL.from} ${formatTime(instance.start, timeZone, hourFormat)}`
                  : item.when === "until"
                    ? `${WHEN_LABEL.until} ${formatTime(instance.end, timeZone, hourFormat)}`
                    : WHEN_LABEL.allDay;
            const past = instance.allDay === true ? day < today : instance.end <= now;
            return (
              <div
                key={item.key}
                data-agenda-row=""
                data-event-key={item.key}
                data-response={instance.response !== "accepted" ? instance.response : undefined}
                data-past={flag(past)}
                role="button"
                tabIndex={-1}
                aria-label={`${instance.title || "(No title)"}, ${time}${instance.location ? `, ${instance.location}` : ""}${response !== null ? `, ${response}` : ""}`}
                style={eventColorStyle(eventColor(instance, calendars))}
                className={cn(
                  "mx-2 flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
                  item.key === selectedKey && "bg-accent",
                  pendingKeys.has(item.key) && "opacity-70",
                )}
              >
                <span className="w-32 shrink-0 truncate text-xs text-muted-foreground tabular-nums">
                  {time}
                </span>
                <span data-event-dot="" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span data-event-title="" className="truncate text-sm">
                    {instance.title || "(No title)"}
                  </span>
                  {instance.location ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {instance.location}
                    </span>
                  ) : null}
                </span>
                {response !== null ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{response}</span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
});
