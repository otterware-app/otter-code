/**
 * Imperative side of `MonthGrid`: dragging events between days (keeping their time of day),
 * drawing all-day events across days, resizing all-day bars, clicks and keyboard nudges.
 * Writes only ghosts and data attributes until a gesture commits.
 */
import { formatEventTime, formatShortDate } from "@t3tools/client-runtime/calendar/format";
import type { Calendar, CalendarEventInstance, CalendarPreferences } from "@t3tools/contracts";
import { DAY_MS, type DayNumber, toZoned } from "@t3tools/shared/calendar/time";

import { eventColor, isEventReadOnly } from "./eventAppearance";
import {
  type DropResult,
  type MonthGeometry,
  changesInstance,
  createAllDay,
  hitMonth,
  resizeAllDayEnd,
  resultDays,
  shiftDays,
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

export interface MonthModel {
  /** Days of the grid, row by row. */
  readonly days: ReadonlyArray<DayNumber>;
  readonly columns: number;
  readonly timeZone: string;
  readonly preferences: CalendarPreferences;
  readonly calendars: ReadonlyMap<string, Calendar>;
  readonly instances: ReadonlyMap<string, CalendarEventInstance>;
  readonly selectedKey: string | null;
  onOpenEvent(instance: CalendarEventInstance, anchor: HTMLElement): void;
  onCreate(draft: CalendarDraft, anchor?: HTMLElement | DOMRect): void;
  onChangeEvent(change: CalendarEventChange): void;
  onOpenDay(day: DayNumber): void;
  onShowMore(day: DayNumber, anchor: HTMLElement): void;
}

export interface MonthElements {
  readonly root: HTMLElement;
  /** The week rows container; ghosts live here. */
  readonly grid: HTMLElement;
  readonly live: HTMLElement;
}

/** Height of a cell's day number row, px (MonthGrid's `top-7` items layer). */
export const MONTH_DAY_HEADER_PX = 28;
const BAR_PX = 20;
const NUDGE_COMMIT_MS = 400;

function sameResult(a: DropResult | null, b: DropResult): boolean {
  return a !== null && a.start === b.start && a.end === b.end && a.allDay === b.allDay;
}

export class MonthController implements GestureHost {
  private readonly gestures: PointerGestures;
  private readonly nudges: NudgeBatch;
  private readonly announcer: Announcer;
  private rovingKey: string | null = null;
  private readonly refocus = new Refocus();
  private nudgedKey: string | null = null;

  constructor(
    private readonly el: MonthElements,
    private readonly model: () => MonthModel,
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
  }

  dispose(): void {
    this.nudges.flush();
    this.gestures.dispose();
    this.announcer.dispose();
    this.el.root.removeEventListener("click", this.onClick);
    this.el.root.removeEventListener("keydown", this.onKeyDown);
    this.el.root.removeEventListener("focusin", this.onFocusIn);
    this.el.root.removeEventListener("focusout", this.onFocusOut);
  }

  afterRender(): void {
    const refocused = this.refocus.apply(this.el.root);
    if (refocused !== null) this.rovingKey = refocused;
    syncRovingFocus(this.el.root, this.rovingKey ?? this.model().selectedKey);
  }

  private measure(): MonthGeometry {
    const { days, columns } = this.model();
    const rect = this.el.grid.getBoundingClientRect();
    const rows = Math.max(1, Math.ceil(days.length / columns));
    return {
      left: rect.left,
      top: rect.top,
      cellWidth: rect.width / columns,
      cellHeight: rect.height / rows,
      columns,
      rows,
    };
  }

  // ── Ghosts ───────────────────────────────────────────────────────

  private ghosts(): HTMLElement[] {
    return [...this.el.grid.querySelectorAll<HTMLElement>(":scope > [data-calendar-ghost]")];
  }

  private hideGhosts(): void {
    for (const ghost of this.ghosts()) delete ghost.dataset.active;
  }

  private showProposal(
    geometry: MonthGeometry,
    result: DropResult,
    meta: { title: string | null; color: string | null; duplicate: boolean },
  ) {
    const { days, timeZone, preferences } = this.model();
    const { first, last } = resultDays(result, timeZone);
    const span = visibleSpan(days, first, last);
    const label = result.allDay ? "" : formatEventTime(result, timeZone, preferences.hourFormat);
    let used = 0;
    const ghosts = this.ghosts();
    if (span !== null) {
      for (let row = 0; row < geometry.rows; row++) {
        const rowStart = row * geometry.columns;
        const from = Math.max(span.startIndex, rowStart);
        const to = Math.min(span.endIndex, rowStart + geometry.columns - 1);
        const ghost = ghosts[used];
        if (from > to || ghost === undefined) continue;
        ghost.style.transform = `translate3d(${(from - rowStart) * geometry.cellWidth + 2}px, ${row * geometry.cellHeight + MONTH_DAY_HEADER_PX}px, 0)`;
        ghost.style.width = `${(to - from + 1) * geometry.cellWidth - 4}px`;
        ghost.style.height = `${BAR_PX}px`;
        if (meta.color !== null) ghost.style.setProperty("--event-color", meta.color);
        else ghost.style.removeProperty("--event-color");
        if (meta.duplicate) ghost.dataset.duplicate = "";
        else delete ghost.dataset.duplicate;
        const [title, time] = ghost.children;
        const titleText = used === 0 ? (meta.title ?? "New event") : "";
        const timeText = used === 0 ? label : "";
        if (title !== undefined && title.textContent !== titleText) title.textContent = titleText;
        if (time !== undefined && time.textContent !== timeText) time.textContent = timeText;
        ghost.dataset.active = "";
        used++;
      }
    }
    for (let index = used; index < ghosts.length; index++) delete ghosts[index]!.dataset.active;
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
      if (
        instance.allDay === true &&
        pressedEdge(target, eventElement, x, y, event, true) === "end"
      ) {
        return this.resizePlan(instance);
      }
      return this.movePlan(instance, x, y);
    }
    if (target.closest("[data-day]") !== null) return this.createPlan(x, y);
    return null;
  }

  private movePlan(instance: CalendarEventInstance, startX: number, startY: number): GesturePlan {
    const key = `${instance.calendarId}/${instance.eventId}`;
    let geometry: MonthGeometry | null = null;
    let grab = 0;
    let result: DropResult | null = null;
    let duplicate = false;
    const meta = () => ({
      title: instance.title || "(No title)",
      color: eventColor(instance, this.model().calendars),
      duplicate,
    });
    return {
      cursor: "move",
      immediate: false,
      activate: () => {
        geometry = this.measure();
        grab = hitMonth(geometry, startX, startY);
        markDragging(this.el.root, key, true);
      },
      update: (x, y, modifiers) => {
        if (geometry === null) return;
        const { days, timeZone } = this.model();
        const index = hitMonth(geometry, x, y);
        const delta = (days[index] ?? days[grab]!) - days[grab]!;
        const next = shiftDays(instance, timeZone, delta);
        if (sameResult(result, next) && duplicate === modifiers.alt) return;
        if (duplicate !== modifiers.alt) markDragging(this.el.root, key, !modifiers.alt);
        result = next;
        duplicate = modifiers.alt;
        this.showProposal(geometry, next, meta());
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
    };
  }

  private resizePlan(instance: CalendarEventInstance): GesturePlan {
    const key = `${instance.calendarId}/${instance.eventId}`;
    let geometry: MonthGeometry | null = null;
    let result: DropResult | null = null;
    return {
      cursor: "resize-x",
      immediate: true,
      activate: () => {
        geometry = this.measure();
        markDragging(this.el.root, key, true);
      },
      update: (x, y) => {
        if (geometry === null) return;
        const { days, calendars } = this.model();
        const next = resizeAllDayEnd(instance, days[hitMonth(geometry, x, y)]!);
        if (sameResult(result, next)) return;
        result = next;
        this.showProposal(geometry, next, {
          title: instance.title || "(No title)",
          color: eventColor(instance, calendars),
          duplicate: false,
        });
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
    };
  }

  private createPlan(startX: number, startY: number): GesturePlan {
    let geometry: MonthGeometry | null = null;
    let anchor = 0;
    let result: DropResult | null = null;
    return {
      cursor: "create",
      immediate: false,
      activate: () => {
        geometry = this.measure();
        anchor = hitMonth(geometry, startX, startY);
      },
      update: (x, y) => {
        if (geometry === null) return;
        const { days } = this.model();
        const index = hitMonth(geometry, x, y);
        const next = createAllDay(days[anchor]!, days[Math.min(index, days.length - 1)]!);
        if (sameResult(result, next)) return;
        result = next;
        this.showProposal(geometry, next, { title: null, color: null, duplicate: false });
      },
      drop: () => {
        const rect = this.ghosts()
          .find((ghost) => ghost.dataset.active !== undefined)
          ?.getBoundingClientRect();
        this.hideGhosts();
        if (result !== null) this.model().onCreate(result, rect);
      },
      cancel: () => this.hideGhosts(),
    };
  }

  // ── Clicks ───────────────────────────────────────────────────────

  private onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const model = this.model();
    const dayButton = target.closest<HTMLElement>("[data-day-number]");
    if (dayButton !== null) {
      model.onOpenDay(Number(dayButton.dataset.dayNumber));
      return;
    }
    const more = target.closest<HTMLElement>("[data-more]");
    if (more !== null) {
      model.onShowMore(Number(more.dataset.more), more);
      return;
    }
    if (target.closest("[data-no-drag]") !== null) return;
    const eventElement = target.closest<HTMLElement>("[data-event-key]");
    if (eventElement !== null) {
      const instance = model.instances.get(eventElement.dataset.eventKey ?? "");
      if (instance !== undefined) model.onOpenEvent(instance, eventElement);
      return;
    }
    const cell = target.closest<HTMLElement>("[data-day]");
    if (cell === null) return;
    const day = Number(cell.dataset.day);
    model.onCreate(createAllDay(day, day), cell.getBoundingClientRect());
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
        if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
          event.preventDefault();
          this.nudge(instance, key, event.key);
        } else if (!event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
          if (focusNeighbour(this.el.root, target, event.key)) event.preventDefault();
        }
        return;
    }
  };

  /** Alt+←/→ moves a day, Alt+↑/↓ a week, keeping the time of day. */
  private nudge(instance: CalendarEventInstance, key: string, arrow: string) {
    const model = this.model();
    if (isEventReadOnly(instance, model.calendars)) {
      this.announcer.say("This event can't be changed here");
      return;
    }
    const base = this.nudges.current(key) ?? {
      start: instance.start,
      end: instance.end,
      allDay: instance.allDay === true,
    };
    const delta =
      arrow === "ArrowLeft" ? -1 : arrow === "ArrowRight" ? 1 : arrow === "ArrowUp" ? -7 : 7;
    const next = shiftDays({ ...instance, ...base }, model.timeZone, delta);
    this.nudges.update({ key, instance, result: next });
    const day = next.allDay
      ? Math.floor(next.start / DAY_MS)
      : toZoned(next.start, model.timeZone).day;
    this.announcer.say(
      `Moved to ${formatShortDate(day)}, ${formatEventTime(next, model.timeZone, model.preferences.hourFormat)}`,
    );
  }

  private showNudge(pending: PendingNudge) {
    this.nudgedKey = pending.key;
    markDragging(this.el.root, pending.key, true);
    this.showProposal(this.measure(), pending.result, {
      title: pending.instance.title || "(No title)",
      color: eventColor(pending.instance, this.model().calendars),
      duplicate: false,
    });
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
