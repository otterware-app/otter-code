/**
 * The calendar, per environment: the directory (accounts, calendars, preferences), week chunks
 * of event instances (a snapshot, then changes), and the commands that change them. Views
 * subscribe to the chunks covering their dates, merge them with `mergeCalendarChunks`, and lay
 * optimistic changes over the result (see `../calendar/optimistic.ts`).
 *
 * Reducers keep identities stable: a chunk's map, and every instance in it, stay the same object
 * until their content changes, so views can memoize on identity and a directory update that only
 * moves `lastSyncedAt` does not re-render every calendar row.
 */
import {
  type Calendar,
  type CalendarAccount,
  type CalendarDirectory,
  type CalendarEventInstance,
  type CalendarWeekEvent,
  type EnvironmentId,
  type GoogleConnectInput,
  SUITE_CALENDAR_METHODS,
} from "@t3tools/contracts";
import { parseOccurrenceId } from "@t3tools/shared/calendar/recurrence";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import { instanceKey, sameInstance } from "../calendar/days.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { runStream } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

/** Instances of one or more week chunks by `calendarEventKey`. */
export type CalendarInstanceMap = ReadonlyMap<string, CalendarEventInstance>;

export const EMPTY_CALENDAR_INSTANCES: CalendarInstanceMap = new Map();
const EMPTY_CALENDAR_INSTANCE_LIST: ReadonlyArray<CalendarEventInstance> = [];

/** Puts `instances` into `next`, reusing the existing object when nothing changed. */
function upsertInto(
  next: Map<string, CalendarEventInstance>,
  current: CalendarInstanceMap,
  instances: ReadonlyArray<CalendarEventInstance>,
): boolean {
  let changed = false;
  for (const instance of instances) {
    const key = instanceKey(instance);
    const existing = current.get(key);
    if (existing !== undefined && sameInstance(existing, instance)) {
      if (next.get(key) !== existing) {
        next.set(key, existing);
        changed = true;
      }
      continue;
    }
    next.set(key, instance);
    changed = true;
  }
  return changed;
}

function sameEntries(left: CalendarInstanceMap, right: CalendarInstanceMap): boolean {
  if (left.size !== right.size) return false;
  for (const [key, instance] of left) {
    if (right.get(key) !== instance) return false;
  }
  return true;
}

/**
 * Applies one week-chunk event. Returns `current` itself when the event changes nothing (a
 * snapshot equal to what is shown, an upsert of an unchanged instance, a removal of unknown keys).
 */
export function applyCalendarWeekEvent(
  current: CalendarInstanceMap,
  event: CalendarWeekEvent,
): CalendarInstanceMap {
  switch (event._tag) {
    case "snapshot": {
      const next = new Map<string, CalendarEventInstance>();
      upsertInto(next, current, event.instances);
      if (sameEntries(next, current)) return current;
      return next.size === 0 ? EMPTY_CALENDAR_INSTANCES : next;
    }
    case "upserted": {
      const next = new Map(current);
      return upsertInto(next, current, event.instances) ? next : current;
    }
    case "removed": {
      if (!event.keys.some((key) => current.has(key))) return current;
      const next = new Map(current);
      for (const key of event.keys) next.delete(key);
      return next;
    }
    case "calendarReplaced": {
      const next = new Map<string, CalendarEventInstance>();
      for (const [key, instance] of current) {
        if (instance.calendarId !== event.calendarId) next.set(key, instance);
      }
      upsertInto(next, current, event.instances);
      return sameEntries(next, current) ? current : next;
    }
  }
}

/**
 * Every instance of the given chunks once, in chunk order. Chunks overlap on events that span
 * a week boundary; the first chunk's copy wins.
 */
export function mergeCalendarChunks(
  chunks: ReadonlyArray<CalendarInstanceMap>,
): ReadonlyArray<CalendarEventInstance> {
  if (chunks.length === 0) return EMPTY_CALENDAR_INSTANCE_LIST;
  if (chunks.length === 1) {
    const only = chunks[0]!;
    return only.size === 0 ? EMPTY_CALENDAR_INSTANCE_LIST : [...only.values()];
  }
  const seen = new Set<string>();
  const merged: CalendarEventInstance[] = [];
  for (const chunk of chunks) {
    for (const [key, instance] of chunk) {
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(instance);
    }
  }
  return merged.length === 0 ? EMPTY_CALENDAR_INSTANCE_LIST : merged;
}

// ── Directory ────────────────────────────────────────────────────────

function shallowEqualRecord<T extends object>(left: T, right: T): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left) as Array<keyof T>;
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => {
    const a = left[key];
    const b = right[key];
    if (a === b) return true;
    // Preferences carry one nested record (working hours) with an array of weekdays.
    return (
      typeof a === "object" &&
      typeof b === "object" &&
      a !== null &&
      b !== null &&
      JSON.stringify(a) === JSON.stringify(b)
    );
  });
}

function shareList<T extends object>(
  previous: ReadonlyArray<T>,
  next: ReadonlyArray<T>,
  keyOf: (item: T) => string,
): ReadonlyArray<T> {
  const byKey = new Map(previous.map((item) => [keyOf(item), item]));
  let changed = previous.length !== next.length;
  const shared = next.map((item, index) => {
    const existing = byKey.get(keyOf(item));
    const kept = existing !== undefined && shallowEqualRecord(existing, item) ? existing : item;
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? shared : previous;
}

/**
 * The next directory, reusing every part of the previous one that did not change (accounts,
 * calendars, preferences), so selectors on one part only fire when that part changes.
 */
export function shareCalendarDirectory(
  previous: CalendarDirectory | null,
  next: CalendarDirectory,
): CalendarDirectory {
  if (previous === null) return next;
  const accounts = shareList<CalendarAccount>(
    previous.accounts,
    next.accounts,
    (account) => account.accountId,
  );
  const calendars = shareList<Calendar>(
    previous.calendars,
    next.calendars,
    (calendar) => calendar.calendarId,
  );
  const preferences = shallowEqualRecord(previous.preferences, next.preferences)
    ? previous.preferences
    : next.preferences;
  const google = shallowEqualRecord(previous.google, next.google) ? previous.google : next.google;
  if (
    accounts === previous.accounts &&
    calendars === previous.calendars &&
    preferences === previous.preferences &&
    google === previous.google
  ) {
    return previous;
  }
  return { accounts, calendars, preferences, google };
}

// ── Atoms and commands ───────────────────────────────────────────────

/** Changes to one event (or one recurring series) run in order across every event command. */
function seriesLaneKey({
  environmentId,
  input,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly calendarId: string; readonly eventId: string };
}): string {
  const seriesId = parseOccurrenceId(input.eventId)?.seriesId ?? input.eventId;
  return JSON.stringify([environmentId, input.calendarId, seriesId]);
}

/** One Google sign-in attempt; a new `attempt` starts a new flow. */
export interface GoogleConnectAttempt extends GoogleConnectInput {
  readonly attempt: number;
}

export function createCalendarEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const eventScheduler = createAtomCommandScheduler();
  const eventLane = { mode: "serial" as const, key: seriesLaneKey };
  return {
    /** Accounts, calendars, preferences and the Google client state. */
    directory: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:calendar:directory",
      tag: SUITE_CALENDAR_METHODS.calendarSubscribeDirectory,
      transform: (stream) =>
        stream.pipe(
          Stream.mapAccum(
            () => null as CalendarDirectory | null,
            (previous, next) => {
              const shared = shareCalendarDirectory(previous, next);
              return [shared, shared === previous ? [] : [shared]] as const;
            },
          ),
        ),
    }),
    /** One week chunk's instances by key (input: the chunk's Monday). */
    week: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:calendar:week",
      tag: SUITE_CALENDAR_METHODS.calendarSubscribeWeek,
      transform: (stream) =>
        stream.pipe(
          Stream.mapAccum(
            () => EMPTY_CALENDAR_INSTANCES,
            (current, event) => {
              const next = applyCalendarWeekEvent(current, event);
              // A snapshot always emits, so an empty week still reads as loaded.
              return [next, next === current && event._tag !== "snapshot" ? [] : [next]] as const;
            },
          ),
        ),
    }),
    /** Everything about one event, for the details popover and the editor. */
    eventDetails: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:calendar:event",
      tag: SUITE_CALENDAR_METHODS.calendarGetEvent,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    getEvent: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:get-event",
      tag: SUITE_CALENDAR_METHODS.calendarGetEvent,
    }),
    search: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:calendar:search",
      tag: SUITE_CALENDAR_METHODS.calendarSearch,
      staleTimeMs: 15_000,
      idleTtlMs: 30_000,
    }),
    createEvent: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:create-event",
      tag: SUITE_CALENDAR_METHODS.calendarCreateEvent,
    }),
    /** Edits to one event run in order, so a slow save never lands after a newer one. */
    updateEvent: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:update-event",
      tag: SUITE_CALENDAR_METHODS.calendarUpdateEvent,
      scheduler: eventScheduler,
      concurrency: eventLane,
    }),
    deleteEvent: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:delete-event",
      tag: SUITE_CALENDAR_METHODS.calendarDeleteEvent,
      scheduler: eventScheduler,
      concurrency: eventLane,
    }),
    respond: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:respond",
      tag: SUITE_CALENDAR_METHODS.calendarRespond,
      scheduler: eventScheduler,
      concurrency: eventLane,
    }),
    restoreEvent: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:restore-event",
      tag: SUITE_CALENDAR_METHODS.calendarRestoreEvent,
      scheduler: eventScheduler,
      concurrency: eventLane,
    }),
    /** Undo and redo: runs steps in order and answers with the steps that revert them. */
    applyChanges: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:apply-changes",
      tag: SUITE_CALENDAR_METHODS.calendarApplyChanges,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => JSON.stringify([environmentId, "calendar-history"]),
      },
    }),
    updateCalendar: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:update-calendar",
      tag: SUITE_CALENDAR_METHODS.calendarUpdateCalendar,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.calendarId]),
      },
    }),
    updatePreferences: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:update-preferences",
      tag: SUITE_CALENDAR_METHODS.calendarUpdatePreferences,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    sync: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:sync",
      tag: SUITE_CALENDAR_METHODS.calendarSync,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.accountId ?? null]),
      },
    }),
    removeAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:remove-account",
      tag: SUITE_CALENDAR_METHODS.calendarRemoveAccount,
    }),
    addDemo: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:add-demo",
      tag: SUITE_CALENDAR_METHODS.calendarAddDemo,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    /**
     * A Google sign-in, streamed: `waiting` (open the URL), `exchanging`, then `succeeded` or
     * `failed`. Unmounting ends the stream, which cancels the flow; it is never replayed after
     * a reconnect.
     */
    googleConnect: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:calendar:google-connect",
      sensitiveInput: true,
      idleTtlMs: 0,
      subscribe: ({ loginHint }: GoogleConnectAttempt) =>
        runStream(SUITE_CALENDAR_METHODS.calendarGoogleConnect, loginHint === undefined ? {} : { loginHint }),
    }),
    googleConnectComplete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:google-connect-complete",
      tag: SUITE_CALENDAR_METHODS.calendarGoogleConnectComplete,
    }),
    googleSetClient: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:google-set-client",
      tag: SUITE_CALENDAR_METHODS.calendarGoogleSetClient,
    }),
    googleClearClient: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:calendar:google-clear-client",
      tag: SUITE_CALENDAR_METHODS.calendarGoogleClearClient,
    }),
  };
}

export type CalendarEnvironmentAtoms = ReturnType<typeof createCalendarEnvironmentAtoms>;
