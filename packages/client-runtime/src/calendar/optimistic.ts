/**
 * Optimistic calendar changes and undo history, shared by web and mobile (no framework here:
 * both stores expose `getState`/`subscribe` for `useSyncExternalStore`).
 *
 * A user action applies its change to the overlay in the same frame, then calls the RPC. The
 * server publishes its own upsert before the RPC answers, so on success the entry is settled
 * (dropped) and the chunk data already shows the result; on failure it is settled too, which
 * rolls the view back, and the client says what failed. Entries apply in order, so a second
 * drag of the same event shows over the first until both settle.
 *
 * Every mutation answers with the steps that undo it. They go on the undo stack; undoing sends
 * them through `calendar.applyChanges`, whose answer is the matching redo entry.
 */
import {
  type Calendar,
  type CalendarChangeStep,
  type CalendarEventInstance,
  type CalendarEventTimeInput,
  calendarEventKey,
} from "@t3tools/contracts";
import {
  DAY_MS,
  dayOfUtcMidnight,
  formatDayNumber,
  formatZonedIso,
  parseDayNumber,
  parseInstant,
} from "@t3tools/shared/calendar/time";

// ── Overlay ──────────────────────────────────────────────────────────

export interface CalendarPatch {
  readonly calendarId: string;
  readonly visible?: boolean;
  readonly color?: string;
}

/** One user action's change, as the views should show it until the server answers. */
export interface OptimisticChange {
  /** Instances to show, new or changed, under their own key (`calendarEventKey`). */
  readonly upsert?: ReadonlyArray<CalendarEventInstance>;
  /** Keys to hide. */
  readonly remove?: ReadonlyArray<string>;
  /** Calendar visibility or color changes. */
  readonly calendars?: ReadonlyArray<CalendarPatch>;
}

export interface OptimisticEntry {
  readonly id: number;
  readonly change: OptimisticChange;
}

export interface OptimisticState {
  /** In the order they were applied; later entries win. */
  readonly entries: ReadonlyArray<OptimisticEntry>;
  /** Keys with a change in flight, for the views' pending style. */
  readonly pendingKeys: ReadonlySet<string>;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();
export const EMPTY_OPTIMISTIC_STATE: OptimisticState = { entries: [], pendingKeys: EMPTY_KEYS };

function stateOf(entries: ReadonlyArray<OptimisticEntry>): OptimisticState {
  if (entries.length === 0) return EMPTY_OPTIMISTIC_STATE;
  const pendingKeys = new Set<string>();
  for (const { change } of entries) {
    for (const instance of change.upsert ?? []) {
      pendingKeys.add(calendarEventKey(instance.calendarId, instance.eventId));
    }
    for (const key of change.remove ?? []) pendingKeys.add(key);
  }
  return { entries, pendingKeys: pendingKeys.size === 0 ? EMPTY_KEYS : pendingKeys };
}

/**
 * The instances to show: `instances` with every pending change applied. Returns `instances`
 * itself when nothing is pending, so memoized consumers keep their identity.
 */
export function applyOptimisticInstances(
  instances: ReadonlyArray<CalendarEventInstance>,
  state: OptimisticState,
): ReadonlyArray<CalendarEventInstance> {
  if (state.entries.length === 0) return instances;
  const upserts = new Map<string, CalendarEventInstance>();
  const removed = new Set<string>();
  for (const { change } of state.entries) {
    for (const key of change.remove ?? []) {
      removed.add(key);
      upserts.delete(key);
    }
    for (const instance of change.upsert ?? []) {
      const key = calendarEventKey(instance.calendarId, instance.eventId);
      removed.delete(key);
      upserts.set(key, instance);
    }
  }
  if (upserts.size === 0 && removed.size === 0) return instances;
  // A created event's own instance can arrive a moment before its RPC answers; the pending copy
  // then steps aside instead of showing twice.
  const created = [...upserts].filter(([, instance]) => isPendingEventId(instance.eventId));
  if (created.length > 0) {
    const arrived = new Set(instances.map(pendingSignature));
    for (const [key, instance] of created) {
      if (arrived.has(pendingSignature(instance))) upserts.delete(key);
    }
  }
  const result: CalendarEventInstance[] = [];
  for (const instance of instances) {
    const key = calendarEventKey(instance.calendarId, instance.eventId);
    if (removed.has(key)) continue;
    const replacement = upserts.get(key);
    if (replacement === undefined) {
      result.push(instance);
    } else {
      result.push(replacement);
      upserts.delete(key);
    }
  }
  for (const instance of upserts.values()) result.push(instance);
  return result;
}

function pendingSignature(instance: CalendarEventInstance): string {
  return `${instance.calendarId}|${instance.start}|${instance.end}|${instance.title}`;
}

/** Calendars with pending visibility and color changes applied (`calendars` when none). */
export function applyOptimisticCalendars(
  calendars: ReadonlyArray<Calendar>,
  state: OptimisticState,
): ReadonlyArray<Calendar> {
  const patches = new Map<string, CalendarPatch>();
  for (const { change } of state.entries) {
    for (const patch of change.calendars ?? []) {
      patches.set(patch.calendarId, { ...patches.get(patch.calendarId), ...patch });
    }
  }
  if (patches.size === 0) return calendars;
  return calendars.map((calendar) => {
    const patch = patches.get(calendar.calendarId);
    if (patch === undefined) return calendar;
    const visible = patch.visible ?? calendar.visible;
    const color = patch.color ?? calendar.color;
    return visible === calendar.visible && color === calendar.color
      ? calendar
      : { ...calendar, visible, color };
  });
}

export interface CalendarOptimisticStore {
  readonly getState: () => OptimisticState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Shows a change now; returns its id for `settle`. */
  readonly apply: (change: OptimisticChange) => number;
  /** Drops a change once its RPC finished, successfully or not. */
  readonly settle: (id: number) => void;
}

export function createCalendarOptimisticStore(): CalendarOptimisticStore {
  let state = EMPTY_OPTIMISTIC_STATE;
  let nextId = 1;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    apply: (change) => {
      const id = nextId++;
      state = stateOf([...state.entries, { id, change }]);
      emit();
      return id;
    },
    settle: (id) => {
      if (!state.entries.some((entry) => entry.id === id)) return;
      state = stateOf(state.entries.filter((entry) => entry.id !== id));
      emit();
    },
  };
}

// ── Times ────────────────────────────────────────────────────────────

/**
 * The wire form of a range: `YYYY-MM-DD` dates (end exclusive) for all-day ranges, whose
 * `start`/`end` are UTC midnights, and ISO instants with the zone's offset for timed ones.
 */
export function eventTimeInput(
  range: { readonly start: number; readonly end: number; readonly allDay: boolean },
  timeZone: string,
): CalendarEventTimeInput {
  if (range.allDay) {
    const startDay = dayOfUtcMidnight(range.start);
    const endDay = Math.max(startDay + 1, dayOfUtcMidnight(range.end));
    return { allDay: true, start: formatDayNumber(startDay), end: formatDayNumber(endDay) };
  }
  return {
    allDay: false,
    start: formatZonedIso(range.start, timeZone),
    end: formatZonedIso(range.end, timeZone),
    timeZone,
  };
}

/** The epoch range of a wire time; null when it does not parse. */
export function parseEventTimeInput(
  time: CalendarEventTimeInput,
): { readonly start: number; readonly end: number; readonly allDay: boolean } | null {
  if (time.allDay) {
    const start = parseDayNumber(time.start);
    const end = parseDayNumber(time.end);
    return start === null || end === null
      ? null
      : { start: start * DAY_MS, end: Math.max(start + 1, end) * DAY_MS, allDay: true };
  }
  const zone = time.timeZone ?? "UTC";
  const start = parseInstant(time.start, zone);
  const end = parseInstant(time.end, zone);
  return start === null || end === null
    ? null
    : { start, end: Math.max(start, end), allDay: false };
}

/** An instance moved to a new range, keeping everything else. */
export function withRange(
  instance: CalendarEventInstance,
  range: { readonly start: number; readonly end: number; readonly allDay: boolean },
): CalendarEventInstance {
  const { allDay: _allDay, ...rest } = instance;
  return range.allDay
    ? { ...rest, start: range.start, end: range.end, allDay: true }
    : { ...rest, start: range.start, end: range.end };
}

let pendingEventCounter = 0;

/** A temporary id for an event being created; the server's own instance replaces it. */
export function pendingEventId(): string {
  pendingEventCounter += 1;
  return `pending-${pendingEventCounter}`;
}

export function isPendingEventId(eventId: string): boolean {
  return eventId.startsWith("pending-");
}

// ── Steps as optimistic changes ──────────────────────────────────────

/**
 * What undo or redo steps will do, as far as the instances on screen tell: moved, renamed,
 * answered, deleted and created events show at once. Restores and series-wide changes are left
 * to the server's updates.
 */
export function optimisticChangeForSteps(
  steps: ReadonlyArray<CalendarChangeStep>,
  lookup: (key: string) => CalendarEventInstance | undefined,
): OptimisticChange {
  const upsert: CalendarEventInstance[] = [];
  const remove: string[] = [];
  const current = new Map<string, CalendarEventInstance | null>();
  const read = (key: string) => {
    const known = current.get(key);
    return known === undefined ? lookup(key) : (known ?? undefined);
  };
  for (const step of steps) {
    switch (step._tag) {
      case "update": {
        const { input } = step;
        const key = calendarEventKey(input.calendarId, input.eventId);
        const existing = read(key);
        const wide = input.scope === "all" || input.scope === "following";
        if (existing === undefined || (wide && existing.seriesId !== undefined)) break;
        let next: CalendarEventInstance = existing;
        const range = input.time === undefined ? null : parseEventTimeInput(input.time);
        if (range !== null) next = withRange(next, range);
        if (input.title !== undefined) next = { ...next, title: input.title };
        if (input.location !== undefined) next = { ...next, location: input.location };
        if (input.free !== undefined) next = { ...next, free: input.free };
        if (input.targetCalendarId !== undefined && input.targetCalendarId !== input.calendarId) {
          remove.push(key);
          current.set(key, null);
          next = { ...next, calendarId: input.targetCalendarId };
        }
        upsert.push(next);
        current.set(calendarEventKey(next.calendarId, next.eventId), next);
        break;
      }
      case "delete": {
        const key = calendarEventKey(step.input.calendarId, step.input.eventId);
        if (read(key) === undefined) break;
        remove.push(key);
        current.set(key, null);
        break;
      }
      case "respond": {
        const key = calendarEventKey(step.input.calendarId, step.input.eventId);
        const existing = read(key);
        if (existing === undefined) break;
        const next = { ...existing, response: step.input.response };
        upsert.push(next);
        current.set(key, next);
        break;
      }
      case "create": {
        const range = parseEventTimeInput(step.input.time);
        if (range === null) break;
        const instance = withRange(
          {
            calendarId: step.input.calendarId,
            eventId: pendingEventId(),
            title: step.input.title ?? "",
            start: range.start,
            end: range.end,
          },
          range,
        );
        upsert.push(instance);
        break;
      }
      case "restore":
        break;
    }
  }
  return {
    ...(upsert.length > 0 ? { upsert } : {}),
    ...(remove.length > 0 ? { remove } : {}),
  };
}

// ── Undo history ─────────────────────────────────────────────────────

export interface CalendarHistoryEntry {
  /** What the change did, e.g. `Moved “Standup”`; undo toasts say `Undid …`. */
  readonly label: string;
  readonly steps: ReadonlyArray<CalendarChangeStep>;
}

export interface CalendarHistoryState {
  readonly undo: ReadonlyArray<CalendarHistoryEntry>;
  readonly redo: ReadonlyArray<CalendarHistoryEntry>;
}

export type CalendarHistoryOutcome =
  | { readonly _tag: "empty" }
  | { readonly _tag: "done"; readonly entry: CalendarHistoryEntry }
  | { readonly _tag: "failed"; readonly entry: CalendarHistoryEntry; readonly error: unknown };

/** Runs steps (via `calendar.applyChanges`) and answers with the steps that revert them. */
export type ApplyCalendarSteps = (
  steps: ReadonlyArray<CalendarChangeStep>,
) => Promise<
  | { readonly ok: true; readonly undo: ReadonlyArray<CalendarChangeStep> }
  | { readonly ok: false; readonly error: unknown }
>;

export interface CalendarHistory {
  readonly getState: () => CalendarHistoryState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Records a finished change; a new change clears the redo stack. */
  readonly record: (entry: CalendarHistoryEntry) => void;
  /** Undo waits for these mutations to finish and record their undo steps. */
  readonly trackMutation: <A>(mutation: () => Promise<A>) => Promise<A>;
  readonly undo: (apply: ApplyCalendarSteps) => Promise<CalendarHistoryOutcome>;
  readonly redo: (apply: ApplyCalendarSteps) => Promise<CalendarHistoryOutcome>;
  readonly clear: () => void;
}

const MAX_HISTORY = 50;
const EMPTY_HISTORY: CalendarHistoryState = { undo: [], redo: [] };

export function createCalendarHistory(): CalendarHistory {
  let state = EMPTY_HISTORY;
  const pendingMutations = new Set<Promise<void>>();
  const listeners = new Set<() => void>();
  const set = (next: CalendarHistoryState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const push = (stack: ReadonlyArray<CalendarHistoryEntry>, entry: CalendarHistoryEntry) =>
    [...stack, entry].slice(-MAX_HISTORY);

  const withStack = (
    which: keyof CalendarHistoryState,
    stack: ReadonlyArray<CalendarHistoryEntry>,
  ): CalendarHistoryState =>
    which === "undo" ? { ...state, undo: stack } : { ...state, redo: stack };

  const run = async (
    from: keyof CalendarHistoryState,
    apply: ApplyCalendarSteps,
  ): Promise<CalendarHistoryOutcome> => {
    // An optimistic delete hides its event before Google answers. Selecting history now would
    // undo the previous edit; a failed edit could then be pushed above the completed delete.
    while (pendingMutations.size > 0) await Promise.all(pendingMutations);
    const to = from === "undo" ? "redo" : "undo";
    const entry = state[from].at(-1);
    if (entry === undefined) return { _tag: "empty" };
    set(withStack(from, state[from].slice(0, -1)));
    let result: Awaited<ReturnType<ApplyCalendarSteps>>;
    try {
      result = await apply(entry.steps);
    } catch (error) {
      result = { ok: false, error };
    }
    if (!result.ok) {
      // Nothing changed on the server, so the entry can be tried again.
      set(withStack(from, push(state[from], entry)));
      return { _tag: "failed", entry, error: result.error };
    }
    if (result.undo.length > 0) {
      set(withStack(to, push(state[to], { label: entry.label, steps: result.undo })));
    }
    return { _tag: "done", entry };
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    record: (entry) => {
      if (entry.steps.length === 0) return;
      set({ undo: push(state.undo, entry), redo: [] });
    },
    trackMutation: async (mutation) => {
      let settle = () => {};
      const pending = new Promise<void>((resolve) => {
        settle = resolve;
      });
      pendingMutations.add(pending);
      try {
        return await mutation();
      } finally {
        pendingMutations.delete(pending);
        settle();
      }
    },
    undo: (apply) => run("undo", apply),
    redo: (apply) => run("redo", apply),
    clear: () => set(EMPTY_HISTORY),
  };
}
