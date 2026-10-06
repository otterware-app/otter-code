/**
 * The calendar page's dialogs: search (`/`), which lists matches by date and opens the picked
 * event where it is, and go to date (`G`).
 */
import { useAtomValue } from "@effect/atom-react";
import {
  type HourFormat,
  formatEventTime,
  formatLongDate,
  formatRelativeDay,
} from "@t3tools/client-runtime/calendar/format";
import type { CalendarDirectory, CalendarEventInstance, EnvironmentId } from "@t3tools/contracts";
import {
  type DayNumber,
  DAY_MS,
  formatDayNumber,
  parseDayNumber,
  toZoned,
} from "@t3tools/shared/calendar/time";
import { useEffect, useId, useMemo, useState } from "react";

import { calendarEnvironment } from "../../state/calendar";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerKeybindingsAtom } from "../../suite/calendar/upstreamShims/serverState";
import type { CommandPaletteActionItem, CommandPaletteGroup } from "../../suite/calendar/upstreamShims/commandPaletteLogic";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { CommandPaletteResults } from "../../suite/calendar/upstreamShims/CommandPaletteResults";
import { Button } from "../ui/button";
import { CommandDialog, CommandDialogPopup } from "../ui/command";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { useCalendarUi } from "./calendarUiStore";
import type { CalendarRange } from "./calendarView.logic";
import { MiniMonth } from "./MiniMonth";

const SEARCH_DELAY_MS = 150;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

function eventDay(instance: CalendarEventInstance, timeZone: string): DayNumber {
  return instance.allDay === true
    ? Math.floor(instance.start / DAY_MS)
    : toZoned(instance.start, timeZone).day;
}

function SearchResults({
  environmentId,
  directory,
  timeZone,
  today,
  onPick,
}: {
  environmentId: EnvironmentId;
  directory: CalendarDirectory;
  timeZone: string;
  today: DayNumber;
  onPick: (instance: CalendarEventInstance) => void;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const trimmed = query.trim();
  const debounced = useDebounced(trimmed, SEARCH_DELAY_MS);
  const search = useEnvironmentQuery(
    debounced.length === 0
      ? null
      : calendarEnvironment.search({ environmentId, input: { query: debounced, limit: 60 } }),
  );
  const hourFormat: HourFormat = directory.preferences.hourFormat;
  const groups = useMemo((): CommandPaletteGroup[] => {
    const results = search.data?.results ?? [];
    const calendars = new Map(
      directory.calendars.map((calendar) => [calendar.calendarId, calendar]),
    );
    const byDay = new Map<DayNumber, CommandPaletteActionItem[]>();
    for (const instance of results) {
      const day = eventDay(instance, timeZone);
      const calendar = calendars.get(instance.calendarId);
      const items = byDay.get(day) ?? [];
      items.push({
        kind: "action",
        value: `event:${instance.calendarId}/${instance.eventId}`,
        searchTerms: [instance.title],
        title: instance.title || "(No title)",
        description: [formatEventTime(instance, timeZone, hourFormat), calendar?.name]
          .filter(Boolean)
          .join(" · "),
        icon: (
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: instance.color ?? calendar?.color }}
          />
        ),
        run: () => onPick(instance),
      });
      byDay.set(day, items);
    }
    return [...byDay]
      .sort(([left], [right]) => left - right)
      .map(([day, items]) => ({
        value: formatDayNumber(day),
        label: Math.abs(day - today) <= 1 ? formatRelativeDay(day, today) : formatLongDate(day),
        items,
      }));
  }, [directory.calendars, hourFormat, onPick, search.data, timeZone, today]);
  const waiting = trimmed.length > 0 && (trimmed !== debounced || search.isPending);
  return (
    <CommandPaletteContent
      aria-label="Search events"
      autoHighlight="always"
      footerActionLabel="Open"
      inputProps={{ placeholder: "Search events by title, place or description" }}
      mode="none"
      onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
      onValueChange={(value) => {
        setHighlighted(null);
        setQuery(value);
      }}
      value={query}
    >
      <CommandPaletteResults
        groups={groups}
        highlightedItemValue={highlighted}
        keybindings={keybindings}
        emptyStateMessage={
          trimmed.length === 0
            ? "Type to search every calendar."
            : waiting
              ? "Searching…"
              : search.error
                ? search.error
                : "No events match."
        }
        onExecuteItem={(item) => {
          if (item.kind === "action") void item.run();
        }}
      />
    </CommandPaletteContent>
  );
}

function GoToDate({
  range,
  today,
  weekStartsOn,
  onGo,
}: {
  range: CalendarRange;
  today: DayNumber;
  weekStartsOn: number;
  onGo: (day: DayNumber) => void;
}) {
  const [value, setValue] = useState(formatDayNumber(range.anchor));
  const parsed = parseDayNumber(value);
  const formId = useId();
  return (
    <>
      <DialogHeader>
        <DialogTitle>Go to date</DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <form
          id={formId}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (parsed !== null) onGo(parsed);
          }}
        >
          <Input
            type="date"
            nativeInput
            aria-label="Date"
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <MiniMonth
            anchor={parsed ?? range.anchor}
            today={today}
            weekStartsOn={weekStartsOn}
            range={parsed === null ? null : { firstDay: parsed, lastDay: parsed }}
            onPick={onGo}
          />
        </form>
      </DialogPanel>
      <DialogFooter>
        <Button type="submit" form={formId} disabled={parsed === null}>
          Go
        </Button>
      </DialogFooter>
    </>
  );
}

export function CalendarDialogs({
  environmentId,
  directory,
  range,
  today,
  timeZone,
  onGoTo,
}: {
  environmentId: EnvironmentId;
  directory: CalendarDirectory;
  range: CalendarRange;
  today: DayNumber;
  timeZone: string;
  onGoTo: (day: DayNumber) => void;
}) {
  const dialog = useCalendarUi((state) => state.dialog);
  const setDialog = useCalendarUi((state) => state.setDialog);
  const openPopover = useCalendarUi((state) => state.openPopover);
  const close = () => setDialog(null);
  return (
    <>
      <CommandDialog
        open={dialog === "search"}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <CommandDialogPopup
          aria-label="Search events"
          className="overflow-hidden"
          data-calendar-search=""
          onBackdropPointerDown={close}
        >
          {dialog === "search" ? (
            <SearchResults
              environmentId={environmentId}
              directory={directory}
              timeZone={timeZone}
              today={today}
              onPick={(instance) => {
                close();
                onGoTo(eventDay(instance, timeZone));
                openPopover(instance, null);
              }}
            />
          ) : null}
        </CommandDialogPopup>
      </CommandDialog>
      <Dialog
        open={dialog === "goToDate"}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogPopup className="max-w-xs" data-calendar-go-to-date="">
          {dialog === "goToDate" ? (
            <GoToDate
              range={range}
              today={today}
              weekStartsOn={directory.preferences.weekStartsOn}
              onGo={(day) => {
                close();
                onGoTo(day);
              }}
            />
          ) : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}
