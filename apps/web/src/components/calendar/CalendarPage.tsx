/**
 * The calendar page: the toolbar in the header, the engine's view for the URL's `view` and
 * `date`, the details popover and the editor panel. It subscribes to the week chunks the view
 * covers (and the neighbouring ones, so paging is instant), merges them with pending changes,
 * and drops hidden calendars and, if the user wants, declined invitations.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  applyOptimisticInstances,
  isPendingEventId,
} from "@t3tools/client-runtime/calendar/optimistic";
import { formatLongDate, formatTimeRange } from "@t3tools/client-runtime/calendar/format";
import { mergeCalendarChunks } from "@t3tools/client-runtime/state/calendar";
import {
  type Calendar,
  type CalendarDirectory,
  type CalendarEventInstance,
  type EnvironmentId,
  calendarEventKey,
} from "@t3tools/contracts";
import { type DayNumber, DAY_MS, formatDayNumber, toZoned } from "@t3tools/shared/calendar/time";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAgentPageContext } from "../../suite/calendar/upstreamShims/agentPanelStore";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import {
  useCalendarChunks,
  useCalendarOptimisticState,
  usePrefetchCalendarChunks,
} from "../../state/calendar";
import { primaryServerKeybindingsAtom } from "../../suite/calendar/upstreamShims/serverState";
import { AppPage, NoEnvironmentState } from "../../suite/calendar/upstreamShims/AppPage";
import {
  duplicateEvent,
  moveEvent,
  redoCalendarChange,
  setShownCalendarInstances,
  undoCalendarChange,
} from "./calendarActions";
import { type CalendarCommand, registerCalendarPage } from "./calendarCommands";
import { CalendarDialogs } from "./CalendarDialogs";
import { CalendarOnboarding } from "./CalendarOnboarding";
import { CalendarSyncStatus, CalendarToolbar } from "./CalendarToolbar";
import { readCalendarUi, useCalendarUi } from "./calendarUiStore";
import {
  AGENDA_DAYS,
  type CalendarRange,
  type CalendarViewKind,
  calendarRange,
  defaultCalendarId,
  defaultDraft,
  hiddenCalendarKey,
  neighbourWeeks,
  rangeWeeks,
  shownInstances,
  stepAnchor,
} from "./calendarView.logic";
import { CalendarViews } from "./CalendarViews";
import { EventEditorPanel } from "./EventEditorPanel";
import { EventPopover } from "./EventPopover";
import { useCalendarContext } from "./useCalendarContext";

const VIEW_BY_COMMAND: Partial<Record<string, CalendarViewKind>> = {
  "calendar.view.day": "day",
  "calendar.view.week": "week",
  "calendar.view.custom": "custom",
  "calendar.view.month": "month",
  "calendar.view.agenda": "agenda",
};

/** Shows a hint only when loading takes long enough to notice. */
function useDelayedFlag(flag: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!flag) return;
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => {
      clearTimeout(timer);
      setShown(false);
    };
  }, [delayMs, flag]);
  return flag && shown;
}

function describeForAgent(
  range: CalendarRange,
  today: DayNumber,
  timeZone: string,
  hourFormat: CalendarDirectory["preferences"]["hourFormat"],
  selected: CalendarEventInstance | null,
  calendars: ReadonlyMap<string, Calendar>,
): string {
  const lines = [
    `Calendar page: ${range.view} view showing ${formatDayNumber(range.firstDay)} to ${formatDayNumber(range.lastDay)}, time zone ${timeZone}. Today is ${formatLongDate(today)}.`,
  ];
  if (selected !== null) {
    const when =
      selected.allDay === true
        ? `${formatLongDate(Math.floor(selected.start / DAY_MS))}, all day`
        : `${formatLongDate(toZoned(selected.start, timeZone).day)}, ${formatTimeRange(selected.start, selected.end, timeZone, hourFormat)}`;
    const calendar = calendars.get(selected.calendarId);
    lines.push(
      `Open event: ${JSON.stringify(selected.title || "(No title)")} (calendarId: ${selected.calendarId}, eventId: ${selected.eventId}${calendar ? `, calendar ${JSON.stringify(calendar.name)}` : ""}), ${when}.`,
    );
  }
  return lines.join("\n");
}

function CalendarBody({
  environmentId,
  directory,
  range,
  timeZone,
  today,
  onLoading,
  onRangeNeeded,
}: {
  environmentId: EnvironmentId;
  directory: CalendarDirectory;
  range: CalendarRange;
  timeZone: string;
  today: DayNumber;
  onLoading: (loading: boolean) => void;
  onRangeNeeded: (fromDay: DayNumber, toDay: DayNumber) => void;
}) {
  const preferences = directory.preferences;
  const { firstDay, lastDay } = range;
  const weeks = useMemo(
    () => rangeWeeks({ firstDay, lastDay }, timeZone),
    [firstDay, lastDay, timeZone],
  );
  const chunks = useCalendarChunks(environmentId, weeks);
  const prefetch = useMemo(
    () => neighbourWeeks(range.view, range.anchor, preferences, timeZone, weeks),
    [range.view, range.anchor, preferences, timeZone, weeks],
  );
  usePrefetchCalendarChunks(environmentId, prefetch);
  const optimistic = useCalendarOptimisticState(environmentId);
  const merged = useMemo(() => mergeCalendarChunks(chunks.maps), [chunks]);
  const withPending = useMemo(
    () => applyOptimisticInstances(merged, optimistic),
    [merged, optimistic],
  );
  const hiddenKey = hiddenCalendarKey(directory.calendars);
  const hidden = useMemo(
    () => new Set(hiddenKey.length === 0 ? [] : hiddenKey.split(",")),
    [hiddenKey],
  );
  const instances = useMemo(
    () => shownInstances(withPending, hidden, preferences.showDeclined),
    [withPending, hidden, preferences.showDeclined],
  );
  const calendars = useMemo(
    () => new Map(directory.calendars.map((calendar) => [calendar.calendarId, calendar])),
    [directory.calendars],
  );
  const loading = useDelayedFlag(chunks.loading, 120);
  useEffect(() => onLoading(chunks.loading), [chunks.loading, onLoading]);
  useEffect(() => setShownCalendarInstances(environmentId, instances), [environmentId, instances]);

  const selectedKey = useCalendarUi((state) => state.selectedKey);
  const openPopover = useCalendarUi((state) => state.openPopover);
  const openEditor = useCalendarUi((state) => state.openEditor);
  const selected = useMemo(
    () =>
      selectedKey === null
        ? null
        : (instances.find(
            (instance) => calendarEventKey(instance.calendarId, instance.eventId) === selectedKey,
          ) ?? null),
    [instances, selectedKey],
  );
  const agentContext = useMemo(
    () => describeForAgent(range, today, timeZone, preferences.hourFormat, selected, calendars),
    [calendars, preferences.hourFormat, range, selected, timeZone, today],
  );
  useAgentPageContext(agentContext);

  // Drafts and events still being created have nothing to show yet.
  const onOpenEvent = useCallback(
    (instance: CalendarEventInstance, anchor: HTMLElement) => {
      if (!isPendingEventId(instance.eventId)) openPopover(instance, anchor);
    },
    [openPopover],
  );
  const onCreate = useCallback(
    (draft: { start: number; end: number; allDay: boolean }) =>
      openEditor({
        mode: "create",
        draft: {
          ...draft,
          calendarId: defaultCalendarId(directory.calendars, preferences.defaultCalendarId),
        },
      }),
    [directory.calendars, openEditor, preferences.defaultCalendarId],
  );
  const onChangeEvent = useCallback(
    (change: {
      instance: CalendarEventInstance;
      start: number;
      end: number;
      allDay: boolean;
      duplicate?: boolean;
    }) => {
      const eventRange = { start: change.start, end: change.end, allDay: change.allDay };
      const ui = readCalendarUi();
      if (ui.editor?.mode === "create" && change.instance.eventId === ui.editor.draft.id) {
        ui.moveDraft(eventRange);
        return;
      }
      if (isPendingEventId(change.instance.eventId)) return;
      if (change.duplicate)
        void duplicateEvent(environmentId, change.instance, eventRange, timeZone);
      else void moveEvent(environmentId, change.instance, eventRange, timeZone);
    },
    [environmentId, timeZone],
  );

  return (
    <>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {loading ? (
          <div
            role="status"
            className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center"
          >
            <span className="rounded-full border border-border bg-popover px-2.5 py-0.5 text-xs text-muted-foreground shadow-xs">
              Loading events…
            </span>
          </div>
        ) : null}
        {chunks.failed && !chunks.loading ? (
          <div
            role="status"
            className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center"
          >
            <span className="rounded-full border border-destructive/30 bg-popover px-2.5 py-0.5 text-xs text-destructive-foreground shadow-xs">
              Some events could not be loaded
            </span>
          </div>
        ) : null}
        <CalendarViews
          range={range}
          instances={instances}
          calendars={calendars}
          timeZone={timeZone}
          preferences={preferences}
          today={today}
          selectedKey={selectedKey}
          pendingKeys={optimistic.pendingKeys}
          onOpenEvent={onOpenEvent}
          onCreate={onCreate}
          onChangeEvent={onChangeEvent}
          onRangeNeeded={onRangeNeeded}
        />
      </div>
      <EventEditorPanel
        environmentId={environmentId}
        directory={directory}
        instances={instances}
        timeZone={timeZone}
      />
      <EventPopover
        environmentId={environmentId}
        instances={instances}
        calendars={calendars}
        accounts={directory.accounts}
        timeZone={timeZone}
        hourFormat={preferences.hourFormat}
      />
    </>
  );
}

export function CalendarPage({
  view,
  date,
  onShow,
}: {
  view: CalendarViewKind;
  date: DayNumber | null;
  /** Shows a view and date at once; the route updates the URL after. */
  onShow: (view: CalendarViewKind, date: DayNumber | null, options: { replace: boolean }) => void;
}) {
  const { environmentId, directory, isLoading, preferences, timeZone, today } =
    useCalendarContext();
  const anchor = date ?? today;
  const [agenda, setAgenda] = useState({ anchor, from: anchor, to: anchor + AGENDA_DAYS - 1 });
  const agendaRange =
    agenda.anchor === anchor ? agenda : { anchor, from: anchor, to: anchor + AGENDA_DAYS - 1 };
  const range = useMemo(() => {
    const base = calendarRange(view, anchor, preferences);
    return view === "agenda"
      ? { ...base, firstDay: agendaRange.from, lastDay: agendaRange.to }
      : base;
  }, [agendaRange.from, agendaRange.to, anchor, preferences, view]);
  const [chunksLoading, setChunksLoading] = useState(false);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const hasAccounts = (directory?.accounts.length ?? 0) > 0;

  const goTo = useCallback(
    (day: DayNumber, options: { view?: CalendarViewKind; replace?: boolean } = {}) => {
      const nextView = options.view ?? view;
      readCalendarUi().closePopover();
      onShow(nextView, day === today ? null : day, { replace: options.replace ?? false });
    },
    [onShow, today, view],
  );

  const runCommand = useCallback(
    (command: CalendarCommand) => {
      if (typeof command === "object") {
        goTo(command.goTo, command.view === undefined ? {} : { view: command.view });
        return;
      }
      const nextView = VIEW_BY_COMMAND[command];
      if (nextView !== undefined) {
        goTo(anchor, { view: nextView });
        return;
      }
      const ui = readCalendarUi();
      switch (command) {
        case "calendar.today":
          goTo(today, { replace: true });
          return;
        case "calendar.next":
        case "calendar.previous":
          goTo(stepAnchor(view, anchor, command === "calendar.next" ? 1 : -1, preferences), {
            replace: true,
          });
          return;
        case "calendar.create": {
          if (!hasAccounts || directory === null) return;
          const day = anchor >= range.firstDay && anchor <= range.lastDay ? anchor : range.firstDay;
          ui.openEditor({
            mode: "create",
            draft: defaultDraft({
              day: today >= range.firstDay && today <= range.lastDay ? today : day,
              today,
              now: Date.now(),
              timeZone,
              minutes: preferences.defaultEventMinutes,
              workingStart: preferences.workingHours.start,
              calendarId: defaultCalendarId(directory.calendars, preferences.defaultCalendarId),
            }),
          });
          return;
        }
        case "calendar.search":
          ui.setDialog("search");
          return;
        case "calendar.goToDate":
          ui.setDialog("goToDate");
          return;
        case "calendar.undo":
          if (environmentId !== null) void undoCalendarChange(environmentId);
          return;
        case "calendar.redo":
          if (environmentId !== null) void redoCalendarChange(environmentId);
          return;
      }
    },
    [
      anchor,
      directory,
      environmentId,
      goTo,
      hasAccounts,
      preferences,
      range,
      timeZone,
      today,
      view,
    ],
  );

  useEffect(() => registerCalendarPage(runCommand), [runCommand]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen()) return;
      if (document.querySelector("[data-slot=dialog-popup], [data-slot=command-dialog-popup]")) {
        return;
      }
      const editable = isEditableFocused(event.target);
      if (event.key === "Escape" && !editable) {
        const ui = readCalendarUi();
        if (ui.popover === null && ui.editor !== null) {
          event.preventDefault();
          ui.closeEditor();
        }
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: { editableFocus: editable },
      });
      if (command === null || !command.startsWith("calendar.")) return;
      event.preventDefault();
      runCommand(command as CalendarCommand);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, runCommand]);

  const onRangeNeeded = useCallback(
    (fromDay: DayNumber, toDay: DayNumber) =>
      setAgenda((current) => {
        const base =
          current.anchor === anchor
            ? current
            : { anchor, from: anchor, to: anchor + AGENDA_DAYS - 1 };
        const from = Math.min(base.from, fromDay);
        const to = Math.max(base.to, toDay);
        return from === base.from && to === base.to && base === current
          ? current
          : { anchor, from, to };
      }),
    [anchor],
  );

  const title = environmentId === null || !hasAccounts ? "Calendar" : range.title;
  return (
    <AppPage
      title={title}
      actions={
        environmentId !== null && hasAccounts && directory !== null ? (
          <CalendarToolbar
            view={view}
            customDays={preferences.customDays}
            todayLabel={formatLongDate(today)}
            onCommand={runCommand}
            status={
              <CalendarSyncStatus environmentId={environmentId} accounts={directory.accounts} />
            }
          />
        ) : null
      }
    >
      <div
        data-calendar-page=""
        data-calendar-view={view}
        data-calendar-date={formatDayNumber(anchor)}
        data-calendar-loading={
          environmentId !== null && (isLoading || (hasAccounts && chunksLoading)) ? "" : undefined
        }
        className="relative flex min-h-0 min-w-0 flex-1"
      >
        {environmentId === null ? (
          <NoEnvironmentState />
        ) : directory === null ? null : !hasAccounts ? (
          <CalendarOnboarding environmentId={environmentId} directory={directory} />
        ) : (
          <CalendarBody
            environmentId={environmentId}
            directory={directory}
            range={range}
            timeZone={timeZone}
            today={today}
            onLoading={setChunksLoading}
            onRangeNeeded={onRangeNeeded}
          />
        )}
      </div>
      {environmentId !== null && directory !== null ? (
        <CalendarDialogs
          environmentId={environmentId}
          directory={directory}
          range={range}
          today={today}
          timeZone={timeZone}
          onGoTo={(day) => goTo(day)}
        />
      ) : null}
    </AppPage>
  );
}
