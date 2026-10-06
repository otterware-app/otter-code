/**
 * Every change the user makes to the calendar, from any entry point (drag, popover, editor,
 * palette, shortcuts): shows it at once through the optimistic overlay, runs the RPC, rolls
 * back with a toast naming what failed, and records the server's undo steps.
 */
import {
  type OptimisticChange,
  eventTimeInput,
  optimisticChangeForSteps,
  pendingEventId,
  withRange,
} from "@t3tools/client-runtime/calendar/optimistic";
import {
  type AtomCommand,
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type Calendar,
  type CalendarChangeScope,
  type CalendarChangeStep,
  type CalendarCreateEventInput,
  type CalendarEventDetails,
  type CalendarEventInstance,
  type CalendarMutationResult,
  type CalendarSendUpdates,
  type CalendarUpdateEventInput,
  type EnvironmentId,
  CalendarId,
  calendarEventKey,
} from "@t3tools/contracts";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { calendarEnvironment, calendarHistory, calendarOptimistic } from "../../state/calendar";
import { toastManager } from "../ui/toast";
import { requestRecurringScope, requestSendUpdates } from "./calendarPrompts";

export interface EventRange {
  readonly start: number;
  readonly end: number;
  readonly allDay: boolean;
}

function quoteTitle(title: string): string {
  return `“${title.trim() || "Untitled"}”`;
}

// ── What is on screen, for optimistic series changes and undo ────────

const shownByEnvironment = new Map<EnvironmentId, ReadonlyArray<CalendarEventInstance>>();

/** The page reports the instances it shows, so changes to a series can move all of them. */
export function setShownCalendarInstances(
  environmentId: EnvironmentId,
  instances: ReadonlyArray<CalendarEventInstance>,
): void {
  shownByEnvironment.set(environmentId, instances);
}

function shownInstances(environmentId: EnvironmentId) {
  return shownByEnvironment.get(environmentId) ?? [];
}

function lookupShown(environmentId: EnvironmentId) {
  const byKey = new Map(
    shownInstances(environmentId).map((instance) => [
      calendarEventKey(instance.calendarId, instance.eventId),
      instance,
    ]),
  );
  return (key: string) => byKey.get(key);
}

/** The shown occurrences a scoped change reaches: just this one, this and later ones, or all. */
function reachedOccurrences(
  environmentId: EnvironmentId,
  instance: CalendarEventInstance,
  scope: CalendarChangeScope | undefined,
): ReadonlyArray<CalendarEventInstance> {
  if (instance.seriesId === undefined || scope === undefined || scope === "this") return [instance];
  const series = shownInstances(environmentId).filter(
    (other) =>
      other.calendarId === instance.calendarId &&
      other.seriesId === instance.seriesId &&
      (scope === "all" || other.start >= instance.start),
  );
  return series.some((other) => other.eventId === instance.eventId)
    ? series
    : [instance, ...series];
}

// ── Running a change ─────────────────────────────────────────────────

function failureDescription(result: AtomCommandResult<unknown, unknown>): string {
  const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

function toastFailure(title: string, result: AtomCommandResult<unknown, unknown>): void {
  if (isAtomCommandInterrupted(result)) return;
  toastManager.add({ type: "error", title, description: failureDescription(result) });
}

function hasChange(change: OptimisticChange | null): change is OptimisticChange {
  return (
    change !== null &&
    ((change.upsert?.length ?? 0) > 0 ||
      (change.remove?.length ?? 0) > 0 ||
      (change.calendars?.length ?? 0) > 0)
  );
}

type EnvironmentTarget<I> = { readonly environmentId: EnvironmentId; readonly input: I };

async function runOptimistic<I, A, E>(
  environmentId: EnvironmentId,
  command: AtomCommand<EnvironmentTarget<I>, A, E>,
  input: I,
  optimistic: OptimisticChange | null,
): Promise<AtomCommandResult<A, E>> {
  const store = calendarOptimistic(environmentId);
  const id = hasChange(optimistic) ? store.apply(optimistic) : null;
  try {
    return await runAtomCommand(
      appAtomRegistry,
      command,
      { environmentId, input },
      { reportFailure: false },
    );
  } finally {
    // The server published its own update before answering, so settling never flickers.
    if (id !== null) store.settle(id);
  }
}

/** Runs one event mutation and puts its undo steps on the history under `label`. */
async function mutate<I>(options: {
  readonly environmentId: EnvironmentId;
  readonly command: AtomCommand<EnvironmentTarget<I>, CalendarMutationResult, unknown>;
  readonly input: I;
  readonly optimistic: OptimisticChange | null;
  readonly label: string;
  readonly failure: string;
}): Promise<CalendarMutationResult | null> {
  const history = calendarHistory(options.environmentId);
  return history.trackMutation(async () => {
    const result = await runOptimistic(
      options.environmentId,
      options.command,
      options.input,
      options.optimistic,
    );
    if (result._tag === "Success") {
      history.record({ label: options.label, steps: result.value.undo });
      return result.value;
    }
    toastFailure(options.failure, result);
    return null;
  });
}

// ── Events ───────────────────────────────────────────────────────────

function readOnlyToast(instance: CalendarEventInstance): void {
  toastManager.add({
    type: "info",
    title: `${quoteTitle(instance.title)} can't be changed here`,
    description: "You can only view this event.",
  });
}

/** A drag or resize from a view, or a keyboard move: asks for the scope of recurring events. */
export async function moveEvent(
  environmentId: EnvironmentId,
  instance: CalendarEventInstance,
  range: EventRange,
  timeZone: string,
): Promise<void> {
  if (instance.readOnly) {
    readOnlyToast(instance);
    return;
  }
  const scope = instance.seriesId === undefined ? undefined : await requestRecurringScope("move");
  if (instance.seriesId !== undefined && scope === null) return;
  const resolvedScope = scope ?? undefined;
  // Other shown occurrences of the series shift with it, unless it turns all-day or timed.
  const delta = range.start - instance.start;
  const duration = range.end - range.start;
  const shiftsSeries = (instance.allDay === true) === range.allDay;
  const upsert = reachedOccurrences(environmentId, instance, resolvedScope).flatMap(
    (occurrence) => {
      if (occurrence.eventId === instance.eventId) return [withRange(occurrence, range)];
      if (!shiftsSeries) return [];
      const start = occurrence.start + delta;
      return [withRange(occurrence, { start, end: start + duration, allDay: range.allDay })];
    },
  );
  await mutate({
    environmentId,
    command: calendarEnvironment.updateEvent,
    input: {
      calendarId: CalendarId.make(instance.calendarId),
      eventId: instance.eventId,
      ...(resolvedScope === undefined ? {} : { scope: resolvedScope }),
      time: eventTimeInput(range, timeZone),
    },
    optimistic: { upsert },
    label: `Moved ${quoteTitle(instance.title)}`,
    failure: `Could not move ${quoteTitle(instance.title)}`,
  });
}

/** Creates an event; the pending instance shows until the server's own arrives. */
export async function createCalendarEvent(
  environmentId: EnvironmentId,
  input: CalendarCreateEventInput,
  preview: EventRange,
  /** The id of the draft already shown for it, so the two never show at once. */
  pendingId: string = pendingEventId(),
): Promise<CalendarEventDetails | null> {
  const title = input.title ?? "";
  const pending = withRange(
    { calendarId: input.calendarId, eventId: pendingId, title, start: 0, end: 0 },
    preview,
  );
  const result = await mutate({
    environmentId,
    command: calendarEnvironment.createEvent,
    input,
    optimistic: { upsert: [pending] },
    label: `Created ${quoteTitle(title)}`,
    failure: `Could not create ${quoteTitle(title)}`,
  });
  return result?.event ?? null;
}

/**
 * A copy of an event (Option-drag, or Duplicate in its popover): same details, no guests or
 * call link, at `range` or the same time.
 */
export async function duplicateEvent(
  environmentId: EnvironmentId,
  instance: CalendarEventInstance,
  range: EventRange | null,
  timeZone: string,
): Promise<CalendarEventDetails | null> {
  const target = range ?? {
    start: instance.start,
    end: instance.end,
    allDay: instance.allDay === true,
  };
  const details = await runAtomCommand(
    appAtomRegistry,
    calendarEnvironment.getEvent,
    {
      environmentId,
      input: { calendarId: CalendarId.make(instance.calendarId), eventId: instance.eventId },
    },
    { reportFailure: false },
  );
  const source = details._tag === "Success" ? details.value : null;
  return createCalendarEvent(
    environmentId,
    {
      calendarId: CalendarId.make(instance.calendarId),
      time: eventTimeInput(target, source?.timeZone ?? timeZone),
      title: instance.title,
      ...(source?.description ? { description: source.description } : {}),
      ...((source?.location ?? instance.location)
        ? { location: source?.location ?? instance.location }
        : {}),
      ...(instance.free ? { free: true } : {}),
    },
    target,
  );
}

/**
 * Saves the editor's changes. Recurring events ask which occurrences it applies to (only
 * "following" and "all" when the repeat rule changed), and events with guests ask whether to
 * notify them.
 */
export async function saveCalendarEvent(
  environmentId: EnvironmentId,
  instance: CalendarEventInstance,
  changes: Omit<CalendarUpdateEventInput, "calendarId" | "eventId" | "scope" | "sendUpdates">,
  options: {
    readonly preview: CalendarEventInstance | null;
    readonly recurrenceChanged: boolean;
    readonly askToNotify: boolean;
    /** Runs once the questions are answered, right before the change shows. */
    readonly onConfirmed?: () => void;
  },
): Promise<boolean> {
  let scope: CalendarChangeScope | undefined;
  if (instance.seriesId !== undefined) {
    const answer = await requestRecurringScope("save", { allowThis: !options.recurrenceChanged });
    if (answer === null) return false;
    scope = answer;
  }
  let sendUpdates: CalendarSendUpdates | undefined;
  if (options.askToNotify) {
    const answer = await requestSendUpdates("save");
    if (answer === null) return false;
    sendUpdates = answer;
  }
  options.onConfirmed?.();
  const preview = options.preview;
  const optimistic: OptimisticChange | null =
    preview === null
      ? null
      : preview.calendarId === instance.calendarId
        ? { upsert: [preview] }
        : { upsert: [preview], remove: [calendarEventKey(instance.calendarId, instance.eventId)] };
  const result = await mutate({
    environmentId,
    command: calendarEnvironment.updateEvent,
    input: {
      ...changes,
      calendarId: CalendarId.make(instance.calendarId),
      eventId: instance.eventId,
      ...(scope === undefined ? {} : { scope }),
      ...(sendUpdates === undefined ? {} : { sendUpdates }),
    },
    optimistic,
    label: `Edited ${quoteTitle(changes.title ?? instance.title)}`,
    failure: `Could not save ${quoteTitle(changes.title ?? instance.title)}`,
  });
  return result !== null;
}

/** Deletes an event (asking for the scope and whether to tell guests), with Undo in the toast. */
export async function deleteCalendarEvent(
  environmentId: EnvironmentId,
  instance: CalendarEventInstance,
  options: { readonly askToNotify?: boolean } = {},
): Promise<boolean> {
  if (instance.readOnly) {
    readOnlyToast(instance);
    return false;
  }
  let scope: CalendarChangeScope | undefined;
  if (instance.seriesId !== undefined) {
    const answer = await requestRecurringScope("delete");
    if (answer === null) return false;
    scope = answer;
  }
  let sendUpdates: CalendarSendUpdates | undefined;
  if (options.askToNotify) {
    const answer = await requestSendUpdates("delete");
    if (answer === null) return false;
    sendUpdates = answer;
  }
  const remove = reachedOccurrences(environmentId, instance, scope).map((occurrence) =>
    calendarEventKey(occurrence.calendarId, occurrence.eventId),
  );
  const result = await mutate({
    environmentId,
    command: calendarEnvironment.deleteEvent,
    input: {
      calendarId: CalendarId.make(instance.calendarId),
      eventId: instance.eventId,
      ...(scope === undefined ? {} : { scope }),
      ...(sendUpdates === undefined ? {} : { sendUpdates }),
    },
    optimistic: { remove },
    label: `Deleted ${quoteTitle(instance.title)}`,
    failure: `Could not delete ${quoteTitle(instance.title)}`,
  });
  if (result === null) return false;
  if (result.undo.length > 0) {
    toastManager.add({
      title: `Deleted ${quoteTitle(instance.title)}`,
      timeout: 5_000,
      actionProps: { children: "Undo", onClick: () => void undoCalendarChange(environmentId) },
      data: { hideCopyButton: true, actionVariant: "outline" },
    });
  }
  return true;
}

/** RSVP; recurring invitations ask whether it answers this occurrence or all. */
export async function respondToEvent(
  environmentId: EnvironmentId,
  instance: CalendarEventInstance,
  response: "accepted" | "declined" | "tentative",
): Promise<void> {
  let scope: "this" | "all" | undefined;
  if (instance.seriesId !== undefined) {
    const answer = await requestRecurringScope("respond");
    if (answer === null) return;
    scope = answer === "this" ? "this" : "all";
  }
  const upsert = reachedOccurrences(environmentId, instance, scope).map((occurrence) => ({
    ...occurrence,
    response,
  }));
  const verb =
    response === "accepted"
      ? "Accepted"
      : response === "declined"
        ? "Declined"
        : "Replied maybe to";
  await mutate({
    environmentId,
    command: calendarEnvironment.respond,
    input: {
      calendarId: CalendarId.make(instance.calendarId),
      eventId: instance.eventId,
      response,
      ...(scope === undefined ? {} : { scope }),
    },
    optimistic: { upsert },
    label: `${verb} ${quoteTitle(instance.title)}`,
    failure: `Could not reply to ${quoteTitle(instance.title)}`,
  });
}

// ── Undo and redo ────────────────────────────────────────────────────

async function runHistory(environmentId: EnvironmentId, direction: "undo" | "redo") {
  const history = calendarHistory(environmentId);
  const outcome = await history[direction](async (steps: ReadonlyArray<CalendarChangeStep>) => {
    const result = await runOptimistic(
      environmentId,
      calendarEnvironment.applyChanges,
      { steps: [...steps] },
      optimisticChangeForSteps(steps, lookupShown(environmentId)),
    );
    return result._tag === "Success"
      ? { ok: true as const, undo: result.value.undo }
      : { ok: false as const, error: squashAtomCommandFailure(result) };
  });
  switch (outcome._tag) {
    case "empty":
      toastManager.add({
        id: "calendar-history",
        title: direction === "undo" ? "Nothing to undo" : "Nothing to redo",
        timeout: 1_500,
      });
      return;
    case "done":
      toastManager.add({
        id: "calendar-history",
        title: `${direction === "undo" ? "Undid" : "Redid"}: ${outcome.entry.label}`,
        timeout: 2_000,
      });
      return;
    case "failed":
      toastManager.add({
        type: "error",
        title: `Could not ${direction} ${outcome.entry.label.charAt(0).toLowerCase()}${outcome.entry.label.slice(1)}`,
        description:
          outcome.error instanceof Error && outcome.error.message
            ? outcome.error.message
            : "Something went wrong.",
      });
  }
}

export function undoCalendarChange(environmentId: EnvironmentId): Promise<void> {
  return runHistory(environmentId, "undo");
}

export function redoCalendarChange(environmentId: EnvironmentId): Promise<void> {
  return runHistory(environmentId, "redo");
}

// ── Calendars ────────────────────────────────────────────────────────

async function updateCalendar(
  environmentId: EnvironmentId,
  calendar: Calendar,
  patch: { readonly visible?: boolean; readonly color?: string },
  failure: string,
): Promise<void> {
  const result = await runOptimistic(
    environmentId,
    calendarEnvironment.updateCalendar,
    { calendarId: calendar.calendarId, ...patch },
    { calendars: [{ calendarId: calendar.calendarId, ...patch }] },
  );
  if (result._tag === "Failure") toastFailure(failure, result);
}

export function setCalendarVisible(
  environmentId: EnvironmentId,
  calendar: Calendar,
  visible: boolean,
): Promise<void> {
  return updateCalendar(
    environmentId,
    calendar,
    { visible },
    `Could not ${visible ? "show" : "hide"} ${calendar.name}`,
  );
}

export function setCalendarColor(
  environmentId: EnvironmentId,
  calendar: Calendar,
  color: string,
): Promise<void> {
  return updateCalendar(environmentId, calendar, { color }, `Could not recolor ${calendar.name}`);
}
