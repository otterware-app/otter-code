/**
 * Imperative side of `TimeGrid`: pointer gestures, clicks, keyboard nudges and the drag ghosts.
 * React renders the static grid; this class reads the latest props through `model()` and writes
 * only to ghosts and data attributes until a gesture commits through a callback.
 */
import {
  formatEventTime,
  formatShortDate,
  formatTimeRange,
} from "@t3tools/client-runtime/calendar/format";
import type { Calendar, CalendarEventInstance, CalendarPreferences } from "@t3tools/contracts";
import { DAY_MS, MINUTE_MS, type DayNumber, toZoned } from "@t3tools/shared/calendar/time";

import { eventColor, isEventReadOnly } from "./eventAppearance";
import {
  type DropResult,
  type GridHit,
  type TimeGridGeometry,
  changesInstance,
  clickSlot,
  createAllDay,
  createTimed,
  dayIndexAt,
  hitTimeGrid,
  moveIntoAllDay,
  moveIntoGrid,
  moveTimed,
  resizeAllDayEnd,
  resizeTimed,
  resultDays,
  shiftDays,
  timedGhostSegments,
  visibleSpan,
} from "./geometry";
import { type GesturePlan, type GestureHost, PointerGestures, pressedEdge } from "./gestures";
import {
  Announcer,
  NudgeBatch,
  type PendingNudge,
  focusNeighbour,
  markDragging,
  Refocus,
  syncRovingFocus,
} from "./keyboard";
import type { CalendarDraft, CalendarEventChange } from "./types";

export interface TimeGridModel {
  readonly days: ReadonlyArray<DayNumber>;
  readonly timeZone: string;
  readonly snapMinutes: number;
  readonly hourHeight: number;
  readonly preferences: CalendarPreferences;
  readonly calendars: ReadonlyMap<string, Calendar>;
  /** Instances shown in the grid, by key. */
  readonly instances: ReadonlyMap<string, CalendarEventInstance>;
  readonly selectedKey: string | null;
  onOpenEvent(instance: CalendarEventInstance, anchor: HTMLElement): void;
  onCreate(draft: CalendarDraft, anchor?: HTMLElement | DOMRect): void;
  onChangeEvent(change: CalendarEventChange): void;
}

export interface TimeGridElements {
  /** The surface root (`data-calendar-surface`): pointer capture and delegated listeners. */
  readonly root: HTMLElement;
  /** The vertical scroll container. */
  readonly scroll: HTMLElement;
  /** The sticky header (day names and all-day lane). */
  readonly header: HTMLElement;
  /** The day columns container; timed ghosts live here and scroll with it. */
  readonly columns: HTMLElement;
  /** The all-day lane's day area; its ghost lives here. */
  readonly lane: HTMLElement;
  /** The polite live region. */
  readonly live: HTMLElement;
}

const MIN_GHOST_PX = 16;
const NUDGE_COMMIT_MS = 400;

interface GhostMeta {
  readonly title: string | null;
  readonly color: string | null;
  readonly duplicate: boolean;
}

function sameResult(a: DropResult | null, b: DropResult): boolean {
  return a !== null && a.start === b.start && a.end === b.end && a.allDay === b.allDay;
}

export class TimeGridController implements GestureHost {
  private readonly gestures: PointerGestures;
  private readonly nudges: NudgeBatch;
  private readonly announcer: Announcer;
  private rovingKey: string | null = null;
  private readonly refocus = new Refocus();
  private nudgedKey: string | null = null;

  constructor(
    private readonly el: TimeGridElements,
    private readonly model: () => TimeGridModel,
  ) {
    this.gestures = new PointerGestures(el.root, this);
    this.announcer = new Announcer(() => this.el.live);
    this.nudges = new NudgeBatch({
      delay: NUDGE_COMMIT_MS,
      show: (pending) => this.showNudge(pending),
      hide: () => this.hideNudge(),
      commit: (pending) => this.commitNudge(pending),
    });
    el.root.addEventListener("click", this.onClick);
    el.root.addEventListener("keydown", this.onKeyDown);
    el.root.addEventListener("focusin", this.onFocusIn);
    el.root.addEventListener("focusout", this.onFocusOut);
    el.root.addEventListener("wheel", this.onWheel, { passive: true });
  }

  dispose(): void {
    this.nudges.flush();
    this.gestures.dispose();
    this.announcer.dispose();
    this.el.root.removeEventListener("wheel", this.onWheel);
    this.el.root.removeEventListener("click", this.onClick);
    this.el.root.removeEventListener("keydown", this.onKeyDown);
    this.el.root.removeEventListener("focusin", this.onFocusIn);
    this.el.root.removeEventListener("focusout", this.onFocusOut);
  }

  /** Called after every render: keeps one tab stop and restores focus after keyboard moves. */
  afterRender(): void {
    const { root } = this.el;
    const refocused = this.refocus.apply(root);
    if (refocused !== null) this.rovingKey = refocused;
    syncRovingFocus(root, this.rovingKey ?? this.model().selectedKey);
  }

  // ── Geometry and ghosts ──────────────────────────────────────────

  private measure(): TimeGridGeometry {
    const { days, hourHeight } = this.model();
    const scrollRect = this.el.scroll.getBoundingClientRect();
    const columnsRect = this.el.columns.getBoundingClientRect();
    return {
      columnsLeft: columnsRect.left,
      columnWidth: columnsRect.width / Math.max(1, days.length),
      dayCount: days.length,
      gridTop: columnsRect.top,
      scrollTop0: this.el.scroll.scrollTop,
      pxPerMinute: hourHeight / 60,
      headerBottom: this.el.header.getBoundingClientRect().bottom,
      viewBottom: scrollRect.bottom,
    };
  }

  private timedGhosts(): HTMLElement[] {
    return [...this.el.columns.querySelectorAll<HTMLElement>(":scope > [data-calendar-ghost]")];
  }

  private laneGhost(): HTMLElement | null {
    return this.el.lane.querySelector<HTMLElement>(":scope > [data-calendar-ghost]");
  }

  private hideGhosts(): void {
    for (const ghost of this.timedGhosts()) delete ghost.dataset.active;
    const lane = this.laneGhost();
    if (lane !== null) delete lane.dataset.active;
  }

  private static paint(
    ghost: HTMLElement,
    meta: GhostMeta,
    x: number,
    y: number,
    width: number,
    height: number | null,
    lines: readonly [string, string],
  ): void {
    ghost.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    ghost.style.width = `${Math.max(0, width)}px`;
    if (height !== null) ghost.style.height = `${height}px`;
    if (meta.color !== null) ghost.style.setProperty("--event-color", meta.color);
    else ghost.style.removeProperty("--event-color");
    if (meta.duplicate) ghost.dataset.duplicate = "";
    else delete ghost.dataset.duplicate;
    const [first, second] = ghost.children;
    if (first !== undefined && first.textContent !== lines[0]) first.textContent = lines[0];
    if (second !== undefined && second.textContent !== lines[1]) second.textContent = lines[1];
    ghost.dataset.active = "";
  }

  /** Draws a proposal: in the lane for all-day results, else as per-column timed segments. */
  private showProposal(
    geometry: TimeGridGeometry,
    result: DropResult,
    meta: GhostMeta,
    inLane: boolean,
  ) {
    const { days, timeZone, preferences } = this.model();
    const timed = this.timedGhosts();
    const lane = this.laneGhost();
    if (inLane) {
      for (const ghost of timed) delete ghost.dataset.active;
      if (lane === null) return;
      const { first, last } = resultDays(result, timeZone);
      const span = visibleSpan(days, first, last);
      if (span === null) {
        delete lane.dataset.active;
        return;
      }
      const label = result.allDay
        ? last > first
          ? `${formatShortDate(first)} – ${formatShortDate(last)}`
          : ""
        : formatTimeRange(result.start, result.end, timeZone, preferences.hourFormat);
      TimeGridController.paint(
        lane,
        meta,
        span.startIndex * geometry.columnWidth + 2,
        0,
        (span.endIndex - span.startIndex + 1) * geometry.columnWidth - 4,
        null,
        [meta.title ?? "New event", label],
      );
      return;
    }
    if (lane !== null) delete lane.dataset.active;
    const segments = timedGhostSegments(days, timeZone, result);
    const label = formatEventTime(result, timeZone, preferences.hourFormat);
    timed.forEach((ghost, index) => {
      const segment = segments[index];
      if (segment === undefined) {
        delete ghost.dataset.active;
        return;
      }
      TimeGridController.paint(
        ghost,
        meta,
        segment.dayIndex * geometry.columnWidth + 1,
        segment.startMinutes * geometry.pxPerMinute,
        geometry.columnWidth - 10,
        Math.max(MIN_GHOST_PX, (segment.endMinutes - segment.startMinutes) * geometry.pxPerMinute),
        index === 0 ? [label, meta.title ?? ""] : ["", ""],
      );
    });
  }

  private ghostRect(): DOMRect | undefined {
    const ghost =
      this.timedGhosts().find((element) => element.dataset.active !== undefined) ??
      (this.laneGhost()?.dataset.active !== undefined ? this.laneGhost() : null);
    return ghost?.getBoundingClientRect();
  }

  // ── Gestures ─────────────────────────────────────────────────────

  planGesture(target: Element, x: number, y: number, event: PointerEvent): GesturePlan | null {
    if (target.closest("[data-no-drag]") !== null) return null;
    this.nudges.flush();
    const eventElement = target.closest<HTMLElement>("[data-event-key]");
    if (eventElement !== null) {
      const model = this.model();
      const instance = model.instances.get(eventElement.dataset.eventKey ?? "");
      if (instance === undefined || isEventReadOnly(instance, model.calendars)) return null;
      const inLane = this.el.lane.contains(eventElement);
      const edge = pressedEdge(target, eventElement, x, y, event, instance.allDay === true);
      if (edge !== null) return this.resizePlan(instance, edge, inLane);
      return this.movePlan(instance, inLane, x, y);
    }
    if (this.el.columns.contains(target)) return this.createTimedPlan(x, y);
    if (this.el.lane.contains(target)) return this.createAllDayPlan(x);
    return null;
  }

  private metaFor(instance: CalendarEventInstance, duplicate: boolean): GhostMeta {
    return {
      title: instance.title || "(No title)",
      color: eventColor(instance, this.model().calendars),
      duplicate,
    };
  }

  private autoScrollBand(geometry: TimeGridGeometry | null) {
    if (geometry === null) return null;
    return { element: this.el.scroll, top: geometry.headerBottom, bottom: geometry.viewBottom };
  }

  private movePlan(
    instance: CalendarEventInstance,
    fromLane: boolean,
    startX: number,
    startY: number,
  ): GesturePlan {
    const key = `${instance.calendarId}/${instance.eventId}`;
    let geometry: TimeGridGeometry | null = null;
    let grab: GridHit | null = null;
    let result: DropResult | null = null;
    let duplicate = false;
    let inLane = fromLane;
    return {
      cursor: "move",
      immediate: false,
      activate: () => {
        geometry = this.measure();
        grab = hitTimeGrid(geometry, startX, startY, this.el.scroll.scrollTop, !fromLane);
        markDragging(this.el.root, key, true);
      },
      update: (x, y, modifiers) => {
        if (geometry === null || grab === null) return;
        const model = this.model();
        const hit = hitTimeGrid(geometry, x, y, this.el.scroll.scrollTop);
        let next: DropResult;
        if (hit.zone === "allDay") {
          next = fromLane
            ? shiftDays(
                instance,
                model.timeZone,
                model.days[hit.dayIndex]! - model.days[grab.dayIndex]!,
              )
            : moveIntoAllDay(model.days[hit.dayIndex]!);
        } else if (fromLane) {
          next = moveIntoGrid(
            model.days,
            model.timeZone,
            instance,
            hit,
            model.snapMinutes,
            model.preferences.defaultEventMinutes,
          );
        } else {
          next = moveTimed(model.days, model.timeZone, instance, grab, hit, model.snapMinutes);
        }
        const nextInLane = hit.zone === "allDay";
        if (sameResult(result, next) && duplicate === modifiers.alt && inLane === nextInLane)
          return;
        if (duplicate !== modifiers.alt) markDragging(this.el.root, key, !modifiers.alt);
        result = next;
        duplicate = modifiers.alt;
        inLane = nextInLane;
        this.showProposal(geometry, next, this.metaFor(instance, duplicate), inLane);
      },
      drop: (modifiers) => {
        this.hideGhosts();
        markDragging(this.el.root, key, false);
        if (result === null) return;
        const copy = duplicate || modifiers.alt;
        if (!copy && !changesInstance(instance, result)) return;
        this.model().onChangeEvent({ instance, ...result, ...(copy ? { duplicate: true } : {}) });
      },
      cancel: () => {
        this.hideGhosts();
        markDragging(this.el.root, key, false);
      },
      autoScroll: () => (inLane ? null : this.autoScrollBand(geometry)),
    };
  }

  private resizePlan(
    instance: CalendarEventInstance,
    edge: "start" | "end",
    inLane: boolean,
  ): GesturePlan {
    const key = `${instance.calendarId}/${instance.eventId}`;
    let geometry: TimeGridGeometry | null = null;
    let result: DropResult | null = null;
    return {
      cursor: inLane ? "resize-x" : "resize",
      immediate: true,
      activate: () => {
        geometry = this.measure();
        markDragging(this.el.root, key, true);
      },
      update: (x, y) => {
        if (geometry === null) return;
        const model = this.model();
        let next: DropResult;
        if (inLane) {
          const index = dayIndexAt(
            x,
            geometry.columnsLeft,
            geometry.columnWidth,
            geometry.dayCount,
          );
          next = resizeAllDayEnd(instance, model.days[index]!);
        } else {
          const hit = hitTimeGrid(geometry, x, y, this.el.scroll.scrollTop, true);
          next = resizeTimed(model.days, model.timeZone, instance, edge, hit, model.snapMinutes);
        }
        if (sameResult(result, next)) return;
        result = next;
        this.showProposal(geometry, next, this.metaFor(instance, false), inLane);
      },
      drop: () => {
        this.hideGhosts();
        markDragging(this.el.root, key, false);
        if (result !== null && changesInstance(instance, result)) {
          this.model().onChangeEvent({ instance, ...result });
        }
      },
      cancel: () => {
        this.hideGhosts();
        markDragging(this.el.root, key, false);
      },
      autoScroll: () => (inLane ? null : this.autoScrollBand(geometry)),
    };
  }

  private createTimedPlan(startX: number, startY: number): GesturePlan {
    let geometry: TimeGridGeometry | null = null;
    let anchor: GridHit | null = null;
    let result: DropResult | null = null;
    return {
      cursor: "create",
      immediate: false,
      activate: () => {
        geometry = this.measure();
        anchor = hitTimeGrid(geometry, startX, startY, this.el.scroll.scrollTop, true);
      },
      update: (x, y) => {
        if (geometry === null || anchor === null) return;
        const model = this.model();
        const hit = hitTimeGrid(geometry, x, y, this.el.scroll.scrollTop, true);
        const next = createTimed(model.days, model.timeZone, anchor, hit, model.snapMinutes);
        if (sameResult(result, next)) return;
        result = next;
        this.showProposal(geometry, next, { title: null, color: null, duplicate: false }, false);
      },
      drop: () => {
        const rect = this.ghostRect();
        this.hideGhosts();
        if (result !== null) this.model().onCreate(result, rect);
      },
      cancel: () => this.hideGhosts(),
      autoScroll: () => this.autoScrollBand(geometry),
    };
  }

  private createAllDayPlan(startX: number): GesturePlan {
    let geometry: TimeGridGeometry | null = null;
    let anchor = 0;
    let result: DropResult | null = null;
    return {
      cursor: "create",
      immediate: false,
      activate: () => {
        geometry = this.measure();
        anchor = dayIndexAt(startX, geometry.columnsLeft, geometry.columnWidth, geometry.dayCount);
      },
      update: (x) => {
        if (geometry === null) return;
        const { days } = this.model();
        const index = dayIndexAt(x, geometry.columnsLeft, geometry.columnWidth, geometry.dayCount);
        const next = createAllDay(days[anchor]!, days[index]!);
        if (sameResult(result, next)) return;
        result = next;
        this.showProposal(geometry, next, { title: null, color: null, duplicate: false }, true);
      },
      drop: () => {
        const rect = this.ghostRect();
        this.hideGhosts();
        if (result !== null) this.model().onCreate(result, rect);
      },
      cancel: () => this.hideGhosts(),
    };
  }

  /** The gesture shield sits outside the scroll container: scroll the grid for it. */
  private onWheel = (event: WheelEvent) => {
    if (
      !(event.target instanceof HTMLElement) ||
      !event.target.hasAttribute("data-gesture-shield")
    ) {
      return;
    }
    const unit =
      event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.el.scroll.clientHeight : 1;
    this.el.scroll.scrollTop += event.deltaY * unit;
  };

  // ── Clicks ───────────────────────────────────────────────────────

  private onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest("[data-no-drag]") !== null) return;
    const model = this.model();
    const eventElement = target.closest<HTMLElement>("[data-event-key]");
    if (eventElement !== null) {
      const instance = model.instances.get(eventElement.dataset.eventKey ?? "");
      if (instance !== undefined) model.onOpenEvent(instance, eventElement);
      return;
    }
    const inColumns = this.el.columns.contains(target);
    if (!inColumns && !this.el.lane.contains(target)) return;
    const geometry = this.measure();
    if (inColumns) {
      const hit = hitTimeGrid(
        geometry,
        event.clientX,
        event.clientY,
        this.el.scroll.scrollTop,
        true,
      );
      const minutes = model.preferences.defaultEventMinutes;
      const draft = clickSlot(model.days, model.timeZone, hit, model.snapMinutes, minutes);
      const startMinutes = toZoned(draft.start, model.timeZone).minutes;
      model.onCreate(
        draft,
        new DOMRect(
          geometry.columnsLeft + hit.dayIndex * geometry.columnWidth,
          geometry.gridTop + startMinutes * geometry.pxPerMinute,
          geometry.columnWidth,
          minutes * geometry.pxPerMinute,
        ),
      );
      return;
    }
    const index = dayIndexAt(
      event.clientX,
      geometry.columnsLeft,
      geometry.columnWidth,
      geometry.dayCount,
    );
    const laneRect = this.el.lane.getBoundingClientRect();
    model.onCreate(
      createAllDay(model.days[index]!, model.days[index]!),
      new DOMRect(
        geometry.columnsLeft + index * geometry.columnWidth,
        laneRect.top,
        geometry.columnWidth,
        laneRect.height,
      ),
    );
  };

  // ── Keyboard ─────────────────────────────────────────────────────

  private onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.dataset.eventKey === undefined) return;
    this.rovingKey = target.dataset.eventKey;
    syncRovingFocus(this.el.root, this.rovingKey);
  };

  private onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    // Leaving the nudged event (not just re-rendering it) commits at once.
    if (next instanceof HTMLElement && next.dataset.eventKey === target.dataset.eventKey) return;
    this.nudges.flush();
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (this.gestures.dragging) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const key = target.dataset.eventKey;
    if (key === undefined) return;
    const model = this.model();
    const instance = model.instances.get(key);
    if (instance === undefined) return;
    switch (event.key) {
      case "Enter":
      case " ":
        event.preventDefault();
        this.nudges.flush();
        model.onOpenEvent(instance, target);
        return;
      case "Escape":
        if (this.nudges.cancel()) {
          event.preventDefault();
          event.stopPropagation();
          this.announcer.say("Change cancelled");
        }
        return;
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight":
        if (event.altKey && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          this.nudge(instance, key, event.key, event.shiftKey);
        } else if (!event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
          if (focusNeighbour(this.el.root, target, event.key)) event.preventDefault();
        }
        return;
    }
  };

  private nudge(instance: CalendarEventInstance, key: string, arrow: string, shift: boolean) {
    const model = this.model();
    if (isEventReadOnly(instance, model.calendars)) {
      this.announcer.say("This event can't be changed here");
      return;
    }
    const base: DropResult = this.nudges.current(key) ?? {
      start: instance.start,
      end: instance.end,
      allDay: instance.allDay === true,
    };
    const step = model.snapMinutes * MINUTE_MS;
    let next: DropResult | null = null;
    if (arrow === "ArrowLeft" || arrow === "ArrowRight") {
      next = shiftDays(
        { ...instance, start: base.start, end: base.end, allDay: base.allDay },
        model.timeZone,
        arrow === "ArrowRight" ? 1 : -1,
      );
    } else {
      const direction = arrow === "ArrowDown" ? 1 : -1;
      if (shift) {
        const unit = base.allDay ? DAY_MS : step;
        next = { ...base, end: Math.max(base.start + unit, base.end + direction * unit) };
      } else if (!base.allDay) {
        next = { ...base, start: base.start + direction * step, end: base.end + direction * step };
      }
    }
    if (next === null) return;
    this.nudges.update({ key, instance, result: next });
    const day = next.allDay
      ? Math.floor(next.start / DAY_MS)
      : toZoned(next.start, model.timeZone).day;
    this.announcer.say(
      `${shift ? "Ends" : "Moved to"} ${formatShortDate(day)}, ${formatEventTime(next, model.timeZone, model.preferences.hourFormat)}`,
    );
  }

  private showNudge(pending: PendingNudge) {
    const geometry = this.measure();
    const inLane = pending.result.allDay || pending.result.end - pending.result.start >= DAY_MS;
    this.nudgedKey = pending.key;
    markDragging(this.el.root, pending.key, true);
    this.showProposal(geometry, pending.result, this.metaFor(pending.instance, false), inLane);
  }

  private hideNudge() {
    this.hideGhosts();
    if (this.nudgedKey !== null) markDragging(this.el.root, this.nudgedKey, false);
    this.nudgedKey = null;
  }

  private commitNudge(pending: PendingNudge) {
    if (!changesInstance(pending.instance, pending.result)) return;
    this.refocus.request(pending.key);
    this.model().onChangeEvent({ instance: pending.instance, ...pending.result });
  }
}
