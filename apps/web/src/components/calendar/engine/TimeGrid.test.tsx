// @vitest-environment jsdom

import {
  type Calendar,
  type CalendarEventInstance,
  DEFAULT_CALENDAR_PREFERENCES,
} from "@t3tools/contracts";
import { fromZoned, parseDayNumber } from "@t3tools/shared/calendar/time";
import { Profiler, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TimeGrid } from "./TimeGrid";
import type { CalendarEventChange } from "./types";

const ZONE = "Europe/Berlin";
const MONDAY = parseDayNumber("2026-09-28")!;
const DAYS = Array.from({ length: 7 }, (_, index) => MONDAY + index);
const HEADER_PX = 80;
const COLUMN_PX = 100;
const GUTTER_PX = 56;

const calendars = new Map<string, Calendar>([
  [
    "cal",
    {
      calendarId: "cal" as Calendar["calendarId"],
      accountId: "acc" as Calendar["accountId"],
      name: "Work",
      color: "#3366ff",
      accessRole: "owner",
      primary: true,
      visible: true,
    },
  ],
]);

const standup: CalendarEventInstance = {
  calendarId: "cal" as CalendarEventInstance["calendarId"],
  eventId: "standup",
  title: "Standup",
  // Wednesday 10:00–10:30.
  start: fromZoned(MONDAY + 2, 600, ZONE),
  end: fromZoned(MONDAY + 2, 630, ZONE),
};

let root: Root;
let container: HTMLDivElement;
let frames: FrameRequestCallback[];

function flushFrames() {
  let time = 0;
  while (frames.length > 0) {
    const pending = frames;
    frames = [];
    for (const callback of pending) callback((time += 16));
  }
}

/** jsdom has no layout: give the grid a fixed geometry (1 px per minute, 100 px columns). */
function stubLayout() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const scroll = document.querySelector<HTMLElement>("[data-calendar-scroll]");
    const scrollTop = scroll?.scrollTop ?? 0;
    if (this.hasAttribute("data-calendar-scroll")) return new DOMRect(0, 0, 1000, 3000);
    if (this.hasAttribute("data-calendar-header")) return new DOMRect(0, 0, 1000, HEADER_PX);
    if (this.hasAttribute("data-calendar-columns")) {
      return new DOMRect(GUTTER_PX, HEADER_PX - scrollTop, COLUMN_PX * 7, 1440);
    }
    // The standup block, Wednesday 10:00–10:30, inset by its 1 px gap.
    if (this.dataset.eventKey === "cal/standup") {
      return new DOMRect(GUTTER_PX + 2 * COLUMN_PX, HEADER_PX - scrollTop + 601, 90, 28);
    }
    return new DOMRect(0, 0, 0, 0);
  });
}

function pointer(
  type: string,
  target: EventTarget,
  x: number,
  y: number,
  init: PointerEventInit = {},
) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      ...init,
    }),
  );
}

/** Viewport point of a wall-clock minute in a day column. */
function point(dayIndex: number, minutes: number) {
  const scrollTop = document.querySelector<HTMLElement>("[data-calendar-scroll]")!.scrollTop;
  return { x: GUTTER_PX + dayIndex * COLUMN_PX + 40, y: HEADER_PX - scrollTop + minutes };
}

function renderGrid() {
  const onChangeEvent = vi.fn<(change: CalendarEventChange) => void>();
  const onOpenEvent = vi.fn();
  const onCreate = vi.fn();
  let commits = 0;
  act(() => {
    root.render(
      <Profiler id="grid" onRender={() => commits++}>
        <TimeGrid
          days={DAYS}
          instances={[standup]}
          calendars={calendars}
          timeZone={ZONE}
          preferences={DEFAULT_CALENDAR_PREFERENCES}
          today={MONDAY + 10}
          selectedKey={null}
          hourHeight={60}
          onOpenEvent={onOpenEvent}
          onCreate={onCreate}
          onChangeEvent={onChangeEvent}
        />
      </Profiler>,
    );
  });
  return { onChangeEvent, onOpenEvent, onCreate, commits: () => commits };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  stubLayout();
  // A fixed clock: the minute timer never re-renders mid-test.
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 5, 8));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TimeGrid gestures", () => {
  it("drags an event without React renders and commits once on drop", () => {
    const grid = renderGrid();
    const block = container.querySelector<HTMLElement>('[data-event-key="cal/standup"]')!;
    expect(block.closest("[data-day]")?.getAttribute("data-day")).toBe(String(MONDAY + 2));
    const commitsBefore = grid.commits();

    const grab = point(2, 610);
    pointer("pointerdown", block, grab.x, grab.y);
    // Under the threshold: still a click.
    pointer("pointermove", document, grab.x + 2, grab.y + 1);
    flushFrames();
    expect(container.querySelector("[data-calendar-ghost][data-active]")).toBeNull();

    // Thursday, about an hour later; many moves coalesce into one frame.
    const drop = point(3, 671);
    for (let step = 1; step <= 10; step++) {
      pointer(
        "pointermove",
        document,
        grab.x + (drop.x - grab.x) * (step / 10),
        grab.y + (drop.y - grab.y) * (step / 10),
      );
    }
    flushFrames();
    const ghost = container.querySelector<HTMLElement>(
      '[data-calendar-ghost="timed"][data-active]',
    );
    expect(ghost).not.toBeNull();
    expect(ghost!.style.transform).toBe("translate3d(301px, 660px, 0)");
    expect(ghost!.textContent).toContain("Standup");
    expect(block.hasAttribute("data-dragging")).toBe(true);
    expect(container.querySelector<HTMLElement>("[data-calendar-surface]")!.dataset.gesture).toBe(
      "move",
    );
    expect(grid.commits()).toBe(commitsBefore);
    expect(grid.onChangeEvent).not.toHaveBeenCalled();

    pointer("pointerup", document, drop.x, drop.y);
    expect(grid.onChangeEvent).toHaveBeenCalledTimes(1);
    expect(grid.onChangeEvent.mock.calls[0]![0]).toMatchObject({
      instance: standup,
      start: fromZoned(MONDAY + 3, 660, ZONE),
      end: fromZoned(MONDAY + 3, 690, ZONE),
      allDay: false,
    });
    expect(container.querySelector("[data-calendar-ghost][data-active]")).toBeNull();
    expect(block.hasAttribute("data-dragging")).toBe(false);

    // The click that follows the drag does not open the event.
    block.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(grid.onOpenEvent).not.toHaveBeenCalled();
  });

  it("cancels on Escape and still opens on a plain click", () => {
    const grid = renderGrid();
    const block = container.querySelector<HTMLElement>('[data-event-key="cal/standup"]')!;
    const grab = point(2, 610);
    pointer("pointerdown", block, grab.x, grab.y);
    pointer("pointermove", document, grab.x, grab.y + 90);
    flushFrames();
    expect(container.querySelector("[data-calendar-ghost][data-active]")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(container.querySelector("[data-calendar-ghost][data-active]")).toBeNull();
    expect(block.hasAttribute("data-dragging")).toBe(false);
    pointer("pointerup", document, grab.x, grab.y + 90);
    expect(grid.onChangeEvent).not.toHaveBeenCalled();

    pointer("pointerdown", block, grab.x, grab.y);
    pointer("pointerup", document, grab.x, grab.y);
    block.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(grid.onOpenEvent).toHaveBeenCalledTimes(1);
    expect(grid.onOpenEvent.mock.calls[0]![0]).toBe(standup);
  });

  it("resizes from the bottom edge and draws new events on empty space", () => {
    const grid = renderGrid();
    // The bottom 6 px of the block resize it; there is no handle element.
    const block = container.querySelector<HTMLElement>('[data-event-key="cal/standup"]')!;
    expect(block.childElementCount).toBe(1);
    const edge = point(2, 627);
    pointer("pointerdown", block, edge.x, edge.y);
    const target = point(2, 718);
    pointer("pointermove", document, target.x, target.y);
    flushFrames();
    pointer("pointerup", document, target.x, target.y);
    expect(grid.onChangeEvent.mock.calls[0]![0]).toMatchObject({
      start: standup.start,
      end: fromZoned(MONDAY + 2, 720, ZONE),
    });

    const column = container.querySelector<HTMLElement>(`[data-day="${MONDAY + 4}"]`)!;
    const from = point(4, 848);
    const to = point(4, 931);
    pointer("pointerdown", column, from.x, from.y);
    pointer("pointermove", document, to.x, to.y);
    flushFrames();
    pointer("pointerup", document, to.x, to.y);
    expect(grid.onCreate).toHaveBeenCalledTimes(1);
    expect(grid.onCreate.mock.calls[0]![0]).toEqual({
      start: fromZoned(MONDAY + 4, 840, ZONE),
      end: fromZoned(MONDAY + 4, 945, ZONE),
      allDay: false,
    });
  });

  it("nudges with Alt+arrows, batching presses into one change", () => {
    const grid = renderGrid();
    const block = container.querySelector<HTMLElement>('[data-event-key="cal/standup"]')!;
    block.focus();
    expect(block.tabIndex).toBe(0);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const press = (key: string, init: KeyboardEventInit = {}) =>
        block.dispatchEvent(
          new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, ...init }),
        );
      press("ArrowDown");
      press("ArrowDown");
      press("ArrowDown", { shiftKey: true });
      const ghost = container.querySelector<HTMLElement>(
        '[data-calendar-ghost="timed"][data-active]',
      );
      expect(ghost?.style.transform).toBe("translate3d(201px, 630px, 0)");
      expect(ghost?.style.height).toBe("45px");
      vi.advanceTimersByTime(399);
      expect(grid.onChangeEvent).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(grid.onChangeEvent).toHaveBeenCalledTimes(1);
      expect(grid.onChangeEvent.mock.calls[0]![0]).toMatchObject({
        start: fromZoned(MONDAY + 2, 630, ZONE),
        end: fromZoned(MONDAY + 2, 675, ZONE),
        allDay: false,
      });
      expect(container.querySelector("[aria-live]")?.textContent).toMatch(
        /^Ends Wed, Sep 30, 10:30/,
      );
      expect(container.querySelector("[data-calendar-ghost][data-active]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
