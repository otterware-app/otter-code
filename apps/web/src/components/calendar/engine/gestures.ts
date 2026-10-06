/**
 * One pointer controller per calendar surface (dnd.md's architecture). It owns the gesture
 * lifecycle and nothing view-specific:
 *
 * - pointerdown asks the view's `planGesture` what the press would start (move, resize,
 *   create) or ignores it;
 * - a mouse drag starts after a 4 px threshold; a touch drag after a 400 ms long-press on an
 *   event or empty space (moving first means the user is scrolling), immediately on resize
 *   handles;
 * - once active it shows the surface's shield (`data-gesture-shield`, a stable child of the
 *   root that carries the cursor) and captures the pointer on it, then calls the plan's
 *   `update` at most once per animation frame with the latest pointer;
 * - it auto-scrolls near the scroll container's edges, re-running `update` as content moves;
 * - pointerup drops; Escape, pointercancel, lost capture, blur and hiding the page cancel;
 * - the click after a real drag is swallowed.
 *
 * No React state changes during a gesture: plans write to the DOM (ghosts, data attributes)
 * and call the view's callbacks once on drop.
 */

import { resizeEdge } from "./geometry";

/**
 * The resize edge a press on an event element hits: a real `[data-resize]` handle, else the
 * drawn edge bands (timed blocks: top and bottom; all-day bars: end). On touch only the
 * selected event resizes, so a long-press anywhere else moves it.
 */
export function pressedEdge(
  target: Element,
  element: HTMLElement,
  x: number,
  y: number,
  event: PointerEvent,
  allDay: boolean,
): "start" | "end" | null {
  const handle = target.closest("[data-resize]")?.getAttribute("data-resize");
  if (handle === "start" || handle === "end") return handle;
  const coarse = event.pointerType !== "mouse";
  if (coarse && !element.hasAttribute("data-selected")) return null;
  const timed = element.hasAttribute("data-timed");
  if (!timed && !(allDay && element.hasAttribute("data-bar"))) return null;
  return resizeEdge(element.getBoundingClientRect(), x, y, {
    vertical: timed,
    start: timed && !element.hasAttribute("data-continues-before"),
    end: !element.hasAttribute("data-continues-after"),
    coarse,
  });
}

export interface GestureModifiers {
  readonly alt: boolean;
}

export interface GesturePlan {
  /** `data-gesture` on the surface while active (drives the cursor). */
  readonly cursor: "move" | "resize" | "resize-x" | "create";
  /** Resize handles start without a long-press on touch. */
  readonly immediate: boolean;
  /** Called once when the gesture becomes a drag: measure geometry, dim the original. */
  activate(): void;
  /** Called per frame (only while something changed) with the latest pointer. */
  update(x: number, y: number, modifiers: GestureModifiers): void;
  /** Called once on release. */
  drop(modifiers: GestureModifiers): void;
  /** Called once when the gesture is abandoned: restore the DOM. */
  cancel(): void;
  /**
   * Auto-scroll: the element and the viewport band (top, bottom) where content is visible.
   * Read after `activate`.
   */
  autoScroll?(): {
    readonly element: HTMLElement;
    readonly top: number;
    readonly bottom: number;
  } | null;
}

export interface GestureHost {
  /** What a primary-button press on `target` would start, or null to leave it to the browser. */
  planGesture(target: Element, x: number, y: number, event: PointerEvent): GesturePlan | null;
}

const DRAG_THRESHOLD_PX = 4;
const TOUCH_SLOP_PX = 8;
const LONG_PRESS_MS = 400;
const EDGE_PX = 44;
const MAX_SCROLL_PX_PER_S = 900;

interface Session {
  readonly pointerId: number;
  readonly plan: GesturePlan;
  readonly touch: boolean;
  readonly startX: number;
  readonly startY: number;
  x: number;
  y: number;
  alt: boolean;
  active: boolean;
  longPress: ReturnType<typeof setTimeout> | null;
}

export class PointerGestures {
  private session: Session | null = null;
  private frame = 0;
  private lastFrameTime = 0;
  private suppressClickUntil = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly host: GestureHost,
  ) {
    root.addEventListener("pointerdown", this.onPointerDown);
    root.addEventListener("click", this.onClickCapture, true);
    root.addEventListener("contextmenu", this.onContextMenu);
    root.addEventListener("pointermove", this.onHover, { passive: true });
    root.addEventListener("pointerleave", this.onHoverEnd);
  }

  private hovered: HTMLElement | null = null;

  /**
   * The resize cursor over an event's edge bands. It is set on the one hovered block rather than
   * drawn with pseudo-elements on every block, which would double the style work of a dense grid.
   */
  private onHover = (event: PointerEvent) => {
    if (this.session !== null || event.pointerType !== "mouse") return;
    const target = event.target instanceof Element ? event.target : null;
    const element =
      target?.closest<HTMLElement>("[data-calendar-event]:not([data-readonly])") ?? null;
    let cursor = "";
    if (element !== null && target !== null) {
      const allDay =
        element.hasAttribute("data-all-day") || this.root.dataset.calendarSurface === "month";
      const edge = pressedEdge(target, element, event.clientX, event.clientY, event, allDay);
      if (edge !== null) cursor = element.hasAttribute("data-timed") ? "ns-resize" : "ew-resize";
    }
    if (this.hovered !== null && this.hovered !== element) this.hovered.style.cursor = "";
    this.hovered = element;
    if (element !== null && element.style.cursor !== cursor) element.style.cursor = cursor;
  };

  private onHoverEnd = () => {
    if (this.hovered !== null) this.hovered.style.cursor = "";
    this.hovered = null;
  };

  dispose(): void {
    this.cancel();
    this.root.removeEventListener("pointerdown", this.onPointerDown);
    this.root.removeEventListener("click", this.onClickCapture, true);
    this.root.removeEventListener("contextmenu", this.onContextMenu);
    this.root.removeEventListener("pointermove", this.onHover);
    this.root.removeEventListener("pointerleave", this.onHoverEnd);
    this.onHoverEnd();
  }

  /** Whether a drag is in progress (views skip keyboard handling meanwhile). */
  get dragging(): boolean {
    return this.session?.active === true;
  }

  private onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    // A press released outside the window never sent pointerup: drop it rather than block.
    if (this.session !== null) this.cancel();
    this.suppressClickUntil = 0;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!(event.target instanceof Element)) return;
    const plan = this.host.planGesture(event.target, event.clientX, event.clientY, event);
    if (plan === null) return;
    const touch = event.pointerType === "touch" || event.pointerType === "pen";
    const session: Session = {
      pointerId: event.pointerId,
      plan,
      touch,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      alt: event.altKey,
      active: false,
      longPress: null,
    };
    this.session = session;
    if (touch && !plan.immediate) {
      session.longPress = setTimeout(() => {
        session.longPress = null;
        if (this.session === session) this.activate(session);
      }, LONG_PRESS_MS);
    }
    const doc = this.root.ownerDocument;
    const view = doc.defaultView ?? window;
    doc.addEventListener("pointermove", this.onPointerMove, true);
    doc.addEventListener("pointerup", this.onPointerUp, true);
    doc.addEventListener("pointercancel", this.onPointerCancel, true);
    doc.addEventListener("keydown", this.onKey, true);
    doc.addEventListener("keyup", this.onKey, true);
    doc.addEventListener("visibilitychange", this.onVisibility);
    view.addEventListener("blur", this.onBlur);
    view.addEventListener("touchmove", this.onTouchMove, { passive: false, capture: true });
    this.root.addEventListener("lostpointercapture", this.onLostCapture);
    this.root.addEventListener("scroll", this.onScroll, true);
  };

  private onPointerMove = (event: PointerEvent) => {
    const session = this.session;
    if (session === null || event.pointerId !== session.pointerId) return;
    session.x = event.clientX;
    session.y = event.clientY;
    session.alt = event.altKey;
    if (!session.active) {
      const distance = Math.hypot(session.x - session.startX, session.y - session.startY);
      if (session.touch && !session.plan.immediate) {
        // Moving before the long-press fires is a scroll: let the browser have it.
        if (distance > TOUCH_SLOP_PX) this.abandon();
        return;
      }
      if (distance < DRAG_THRESHOLD_PX) return;
      this.activate(session);
      return;
    }
    this.schedule();
  };

  private onPointerUp = (event: PointerEvent) => {
    const session = this.session;
    if (session === null || event.pointerId !== session.pointerId) return;
    session.x = event.clientX;
    session.y = event.clientY;
    session.alt = event.altKey;
    if (!session.active) {
      this.abandon();
      return;
    }
    // Apply the final position before dropping, in case a frame is still pending.
    session.plan.update(session.x, session.y, { alt: session.alt });
    this.teardown();
    this.suppressNextClick();
    session.plan.drop({ alt: session.alt });
  };

  private onPointerCancel = (event: PointerEvent) => {
    if (this.session !== null && event.pointerId === this.session.pointerId) this.cancel();
  };

  private onLostCapture = (event: PointerEvent) => {
    const session = this.session;
    if (session !== null && session.active && event.pointerId === session.pointerId) this.cancel();
  };

  private onKey = (event: KeyboardEvent) => {
    const session = this.session;
    if (session === null) return;
    if (event.key === "Escape" && event.type === "keydown") {
      if (session.active) {
        event.preventDefault();
        event.stopPropagation();
      }
      this.cancel();
      return;
    }
    if (event.key === "Alt" && session.active && session.alt !== event.altKey) {
      session.alt = event.altKey;
      this.schedule();
    }
  };

  private onBlur = () => this.cancel();

  private onVisibility = () => {
    if (this.root.ownerDocument.visibilityState === "hidden") this.cancel();
  };

  private onScroll = () => {
    if (this.session?.active === true) this.schedule();
  };

  private onTouchMove = (event: TouchEvent) => {
    // Once a touch drag is active the finger drives the gesture, not the page.
    if (this.session?.active === true && event.cancelable) event.preventDefault();
  };

  private onContextMenu = (event: Event) => {
    // Android opens the context menu on long-press; the long-press is ours.
    if (this.session !== null) event.preventDefault();
  };

  private onClickCapture = (event: MouseEvent) => {
    if (performance.now() < this.suppressClickUntil) {
      this.suppressClickUntil = 0;
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private suppressNextClick() {
    // The click that follows pointerup arrives within the same input task; a short window
    // makes sure a click that never comes cannot swallow a later one.
    this.suppressClickUntil = performance.now() + 400;
  }

  private activate(session: Session) {
    if (session.longPress !== null) {
      clearTimeout(session.longPress);
      session.longPress = null;
    }
    session.active = true;
    // Show the shield (it carries the gesture cursor), then capture on it: the cursor follows
    // the capturing element, and no event element changes style.
    this.root.dataset.gesture = session.plan.cursor;
    try {
      this.captureTarget().setPointerCapture(session.pointerId);
    } catch {
      // The pointer is already gone; the next event cancels.
    }
    if (session.touch) navigator.vibrate?.(8);
    session.plan.activate();
    this.lastFrameTime = 0;
    this.schedule();
  }

  private schedule() {
    if (this.frame === 0) this.frame = requestAnimationFrame(this.onFrame);
  }

  private onFrame = (time: number) => {
    this.frame = 0;
    const session = this.session;
    if (session === null || !session.active) return;
    session.plan.update(session.x, session.y, { alt: session.alt });
    const elapsed = this.lastFrameTime === 0 ? 16 : Math.min(64, time - this.lastFrameTime);
    this.lastFrameTime = time;
    const band = session.plan.autoScroll?.() ?? null;
    if (band === null) return;
    let velocity = 0;
    if (session.y < band.top + EDGE_PX) {
      velocity =
        -MAX_SCROLL_PX_PER_S * Math.min(1, (band.top + EDGE_PX - session.y) / EDGE_PX) ** 2;
    } else if (session.y > band.bottom - EDGE_PX) {
      velocity =
        MAX_SCROLL_PX_PER_S * Math.min(1, (session.y - band.bottom + EDGE_PX) / EDGE_PX) ** 2;
    }
    if (velocity === 0) {
      this.lastFrameTime = 0;
      return;
    }
    const element = band.element;
    const before = element.scrollTop;
    element.scrollTop = before + (velocity * elapsed) / 1000;
    // Keep scrolling while the pointer rests in the edge band.
    if (element.scrollTop !== before) this.schedule();
  };

  /** Abandons a press that never became a drag (a click, or a touch scroll). */
  private abandon() {
    const session = this.session;
    if (session === null) return;
    this.teardown();
    if (session.active) session.plan.cancel();
  }

  /** Cancels any gesture, restoring the DOM. */
  cancel(): void {
    const session = this.session;
    if (session === null) return;
    this.teardown();
    if (session.active) {
      this.suppressNextClick();
      session.plan.cancel();
    }
  }

  private teardown() {
    const session = this.session;
    this.session = null;
    if (session?.longPress != null) clearTimeout(session.longPress);
    if (this.frame !== 0) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    delete this.root.dataset.gesture;
    const doc = this.root.ownerDocument;
    const view = doc.defaultView ?? window;
    doc.removeEventListener("pointermove", this.onPointerMove, true);
    doc.removeEventListener("pointerup", this.onPointerUp, true);
    doc.removeEventListener("pointercancel", this.onPointerCancel, true);
    doc.removeEventListener("keydown", this.onKey, true);
    doc.removeEventListener("keyup", this.onKey, true);
    doc.removeEventListener("visibilitychange", this.onVisibility);
    view.removeEventListener("blur", this.onBlur);
    view.removeEventListener("touchmove", this.onTouchMove, { capture: true });
    this.root.removeEventListener("lostpointercapture", this.onLostCapture);
    this.root.removeEventListener("scroll", this.onScroll, true);
    const target = this.captureTarget();
    if (session?.active === true && target.hasPointerCapture?.(session.pointerId) === true) {
      target.releasePointerCapture(session.pointerId);
    }
  }

  /** The surface's shield when it has one (a direct child), else the root itself. */
  private captureTarget(): HTMLElement {
    return this.root.querySelector<HTMLElement>(":scope > [data-gesture-shield]") ?? this.root;
  }
}
