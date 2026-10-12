/**
 * Keyboard support shared by the grids: one tab stop per view (roving focus over event
 * elements), arrow keys between events, and batched Alt+arrow nudges that commit once after
 * the user pauses, announced through a live region.
 */
import type { CalendarEventInstance } from "@t3tools/contracts";

import type { DropResult } from "./geometry";

const EVENT_SELECTOR = "[data-event-key]";

function eventElement(root: HTMLElement, key: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-event-key="${CSS.escape(key)}"]`);
}

/**
 * Keeps exactly one event element tabbable: the preferred key when shown, else the current
 * stop, else the first event. Elements render with tabIndex -1; this only flips attributes.
 */
export function syncRovingFocus(root: HTMLElement, preferredKey: string | null): void {
  const current = root.querySelector<HTMLElement>(`${EVENT_SELECTOR}[tabindex="0"]`);
  const wanted =
    (preferredKey !== null ? eventElement(root, preferredKey) : null) ??
    current ??
    root.querySelector<HTMLElement>(EVENT_SELECTOR);
  if (current !== null && current !== wanted) current.tabIndex = -1;
  if (wanted !== null && wanted.tabIndex !== 0) wanted.tabIndex = 0;
}

/** Moves focus to the nearest event in an arrow key's direction. Returns whether it moved. */
export function focusNeighbour(root: HTMLElement, from: HTMLElement, key: string): boolean {
  const origin = from.getBoundingClientRect();
  const originX = origin.left + origin.width / 2;
  const originY = origin.top + origin.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const element of root.querySelectorAll<HTMLElement>(EVENT_SELECTOR)) {
    if (element === from || element.dataset.eventKey === from.dataset.eventKey) continue;
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const dx = x - originX;
    const dy = y - originY;
    let score: number;
    switch (key) {
      case "ArrowUp":
      case "ArrowDown": {
        const ahead = key === "ArrowDown" ? rect.top >= origin.top + 1 : rect.top <= origin.top - 1;
        const sameColumn = rect.left < origin.right && rect.right > origin.left;
        if (!ahead || !sameColumn) continue;
        score = Math.abs(dy) + Math.abs(dx) * 0.1;
        break;
      }
      case "ArrowLeft":
      case "ArrowRight": {
        const ahead = key === "ArrowRight" ? dx > origin.width / 2 : dx < -origin.width / 2;
        if (!ahead) continue;
        score = Math.abs(dx) + Math.abs(dy) * 2;
        break;
      }
      default:
        return false;
    }
    if (score < bestScore) {
      bestScore = score;
      best = element;
    }
  }
  if (best === null) return false;
  best.focus();
  best.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

export interface PendingNudge {
  readonly key: string;
  readonly instance: CalendarEventInstance;
  readonly result: DropResult;
}

/**
 * Coalesces rapid keyboard nudges on one event into one commit, `delay` ms after the last key
 * (or at once on `flush`, e.g. when focus leaves the event).
 */
export class NudgeBatch {
  private pending: PendingNudge | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly options: {
      readonly delay: number;
      show(pending: PendingNudge): void;
      hide(): void;
      commit(pending: PendingNudge): void;
    },
  ) {}

  /** The proposal waiting for `key`, to nudge further from. */
  current(key: string): DropResult | null {
    return this.pending?.key === key ? this.pending.result : null;
  }

  update(pending: PendingNudge): void {
    if (this.pending !== null && this.pending.key !== pending.key) this.flush();
    this.pending = pending;
    this.options.show(pending);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.options.delay);
  }

  flush(): void {
    const pending = this.pending;
    this.clear();
    if (pending === null) return;
    this.options.hide();
    this.options.commit(pending);
  }

  /** Drops the pending nudge (Escape). Returns whether there was one. */
  cancel(): boolean {
    const had = this.pending !== null;
    this.clear();
    if (had) this.options.hide();
    return had;
  }

  private clear() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}

/**
 * Polite announcements, debounced so a burst of nudges reads once. Writes text into an existing
 * live region element; no React state.
 */
export class Announcer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly region: () => HTMLElement | null) {}

  say(text: string): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const region = this.region();
      if (region !== null) region.textContent = text;
    }, 120);
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
  }
}

/** Dims (or restores) every element of an event while it is dragged or nudged. */
export function markDragging(root: HTMLElement, key: string, dragging: boolean): void {
  for (const element of root.querySelectorAll<HTMLElement>(
    `[data-event-key="${CSS.escape(key)}"]`,
  )) {
    if (dragging) element.dataset.dragging = "";
    else delete element.dataset.dragging;
  }
}

/**
 * Restores focus to an event after a keyboard move re-rendered it elsewhere. Call after each
 * render until it returns true; the request lapses after a second, so an event that never
 * reappears cannot grab focus later.
 */
export class Refocus {
  private key: string | null = null;
  private until = 0;

  request(key: string): void {
    this.key = key;
    this.until = performance.now() + 1000;
  }

  /** Returns the key focus was restored to, if any. */
  apply(root: HTMLElement): string | null {
    const key = this.key;
    if (key === null) return null;
    if (performance.now() > this.until) {
      this.key = null;
      return null;
    }
    const element = eventElement(root, key);
    const active = root.ownerDocument.activeElement;
    if (active !== null && active !== root.ownerDocument.body) {
      // Focus is still on the event (the change has not rendered, or did not move it), or the
      // user moved on: nothing to restore yet, or ever.
      if (element === null || active !== element) this.key = null;
      return null;
    }
    // The focused element was replaced when the event moved: focus its new element.
    if (element === null) return null;
    element.focus();
    this.key = null;
    return key;
  }
}
