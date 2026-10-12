import { useAtomMount, useAtomValue } from "@effect/atom-react";
import {
  type CalendarHistory,
  type CalendarOptimisticStore,
  type OptimisticState,
  EMPTY_OPTIMISTIC_STATE,
  applyOptimisticCalendars,
  createCalendarHistory,
  createCalendarOptimisticStore,
} from "@t3tools/client-runtime/calendar/optimistic";
import {
  type CalendarInstanceMap,
  EMPTY_CALENDAR_INSTANCES,
  createCalendarEnvironmentAtoms,
} from "@t3tools/client-runtime/state/calendar";
import type { CalendarDirectory, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo, useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "../connection/runtime";

export const calendarEnvironment = createCalendarEnvironmentAtoms(connectionAtomRuntime);

// ── Optimistic changes and undo, per environment ─────────────────────

const optimisticStores = new Map<EnvironmentId, CalendarOptimisticStore>();
const histories = new Map<EnvironmentId, CalendarHistory>();

export function calendarOptimistic(environmentId: EnvironmentId): CalendarOptimisticStore {
  let store = optimisticStores.get(environmentId);
  if (store === undefined) {
    store = createCalendarOptimisticStore();
    optimisticStores.set(environmentId, store);
  }
  return store;
}

export function calendarHistory(environmentId: EnvironmentId): CalendarHistory {
  let history = histories.get(environmentId);
  if (history === undefined) {
    history = createCalendarHistory();
    histories.set(environmentId, history);
  }
  return history;
}

const NO_SUBSCRIPTION = () => () => undefined;

export function useCalendarOptimisticState(environmentId: EnvironmentId | null): OptimisticState {
  const store = environmentId === null ? null : calendarOptimistic(environmentId);
  return useSyncExternalStore(
    store?.subscribe ?? NO_SUBSCRIPTION,
    store?.getState ?? (() => EMPTY_OPTIMISTIC_STATE),
  );
}

// ── Directory ────────────────────────────────────────────────────────

const EMPTY_DIRECTORY_ATOM = Atom.make(AsyncResult.initial<CalendarDirectory, never>(false)).pipe(
  Atom.withLabel("web-calendar:no-directory"),
);

export interface CalendarDirectoryView {
  /** With pending visibility and color changes applied; null until the first snapshot. */
  readonly directory: CalendarDirectory | null;
  readonly isLoading: boolean;
  readonly error: boolean;
}

/** Accounts, calendars and preferences of the environment, as the user last changed them. */
export function useCalendarDirectory(environmentId: EnvironmentId | null): CalendarDirectoryView {
  const result = useAtomValue(
    environmentId === null
      ? EMPTY_DIRECTORY_ATOM
      : calendarEnvironment.directory({ environmentId, input: {} }),
  );
  const optimistic = useCalendarOptimisticState(environmentId);
  const directory = Option.getOrNull(AsyncResult.value(result));
  const calendars = useMemo(
    () => (directory === null ? null : applyOptimisticCalendars(directory.calendars, optimistic)),
    [directory, optimistic],
  );
  const shown = useMemo(
    () =>
      directory === null || calendars === null
        ? null
        : calendars === directory.calendars
          ? directory
          : { ...directory, calendars },
    [calendars, directory],
  );
  return {
    directory: shown,
    isLoading: environmentId !== null && result._tag === "Initial",
    error: result._tag === "Failure" && directory === null,
  };
}

// ── Week chunks ──────────────────────────────────────────────────────

export interface CalendarChunks {
  /** One map per requested week, in order; empty until that week's snapshot arrives. */
  readonly maps: ReadonlyArray<CalendarInstanceMap>;
  /** Some week has no snapshot yet. */
  readonly loading: boolean;
  /** Some week failed to load. */
  readonly failed: boolean;
}

const EMPTY_CHUNKS: CalendarChunks = { maps: [], loading: false, failed: false };
const EMPTY_CHUNKS_ATOM = Atom.make(EMPTY_CHUNKS).pipe(Atom.withLabel("web-calendar:no-chunks"));

/**
 * The given week chunks as one value that keeps its identity until one of the weeks changes,
 * so views memoize their merge on it.
 */
const chunksAtom = Atom.family((key: string) => {
  const [environmentId, weeks] = JSON.parse(key) as [EnvironmentId, ReadonlyArray<string>];
  return Atom.make((get): CalendarChunks => {
    let loading = false;
    let failed = false;
    const maps = weeks.map((week) => {
      const result = get(calendarEnvironment.week({ environmentId, input: { week } }));
      if (result._tag === "Initial") loading = true;
      else if (result._tag === "Failure" && Option.isNone(AsyncResult.value(result))) failed = true;
      return Option.getOrElse(AsyncResult.value(result), () => EMPTY_CALENDAR_INSTANCES);
    });
    const previous = Option.getOrNull(get.self<CalendarChunks>());
    if (
      previous !== null &&
      previous.loading === loading &&
      previous.failed === failed &&
      previous.maps.length === maps.length &&
      previous.maps.every((map, index) => map === maps[index])
    ) {
      return previous;
    }
    return { maps, loading, failed };
  }).pipe(Atom.withLabel(`web-calendar:chunks:${key}`));
});

function chunksKey(environmentId: EnvironmentId, weeks: ReadonlyArray<string>) {
  return JSON.stringify([environmentId, weeks]);
}

/** Subscribes to the week chunks a view shows; the chunks keep streaming changes. */
export function useCalendarChunks(
  environmentId: EnvironmentId | null,
  weeks: ReadonlyArray<string>,
): CalendarChunks {
  const key = environmentId === null ? null : chunksKey(environmentId, weeks);
  return useAtomValue(key === null ? EMPTY_CHUNKS_ATOM : chunksAtom(key));
}

/** Keeps neighbouring weeks subscribed without rendering from them, so paging is instant. */
export function usePrefetchCalendarChunks(
  environmentId: EnvironmentId | null,
  weeks: ReadonlyArray<string>,
): void {
  const key = environmentId === null ? null : chunksKey(environmentId, weeks);
  useAtomMount(key === null ? EMPTY_CHUNKS_ATOM : chunksAtom(key));
}
