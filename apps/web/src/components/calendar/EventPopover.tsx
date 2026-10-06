/**
 * An event's details next to the block the user clicked: when (in the user's zone and the
 * event's own), where, the call link, guests and the user's RSVP, the description and how it
 * repeats, and actions. E edits, Delete removes, Esc closes; focus returns to the block.
 */
import type { HourFormat } from "@t3tools/client-runtime/calendar/format";
import { isPendingEventId } from "@t3tools/client-runtime/calendar/optimistic";
import {
  type Calendar,
  type CalendarAccount,
  type CalendarAttendee,
  type CalendarEventDetails,
  type CalendarEventInstance,
  type EnvironmentId,
  CalendarId,
  calendarEventKey,
} from "@t3tools/contracts";
import { describeRecurrence } from "@t3tools/shared/calendar/recurrence";
import {
  AlignLeftIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CircleIcon,
  CircleXIcon,
  CopyIcon,
  ExternalLinkIcon,
  MapPinIcon,
  PencilIcon,
  RepeatIcon,
  Trash2Icon,
  UsersIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ensureLocalApi } from "../../localApi";
import { isEditableFocused } from "../../lib/editableFocus";
import { calendarEnvironment } from "../../state/calendar";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Popover, PopoverPopup } from "../ui/popover";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { deleteCalendarEvent, duplicateEvent, respondToEvent } from "./calendarActions";
import { describeEventWhen, describeEventZone, isHttpUrl, locationHref } from "./calendarFormat";
import { readCalendarUi, useCalendarUi } from "./calendarUiStore";

const GUESTS_SHOWN = 6;

/** Google descriptions are HTML; the popover shows their text. */
function descriptionText(description: string): string {
  if (!/[<&]/.test(description)) return description.trim();
  const html = description.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n");
  const text = new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function ResponseIcon({ status }: { status: CalendarAttendee["responseStatus"] }) {
  switch (status) {
    case "accepted":
      return <CircleCheckIcon className="size-3.5 text-success" aria-label="Going" />;
    case "tentative":
      return <CircleHelpIcon className="size-3.5 text-warning" aria-label="Maybe" />;
    case "declined":
      return <CircleXIcon className="size-3.5 text-destructive" aria-label="Not going" />;
    case "needsAction":
      return <CircleIcon className="size-3.5 text-muted-foreground" aria-label="Awaiting" />;
  }
}

function guestSummary(attendees: ReadonlyArray<CalendarAttendee>): string {
  const count = (status: CalendarAttendee["responseStatus"]) =>
    attendees.filter((attendee) => attendee.responseStatus === status).length;
  const parts = [
    [count("accepted"), "yes"],
    [count("tentative"), "maybe"],
    [count("declined"), "no"],
    [count("needsAction"), "awaiting"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, label]) => `${n} ${label}`);
  return `${attendees.length} guest${attendees.length === 1 ? "" : "s"}${parts.length > 0 ? ` · ${parts.join(", ")}` : ""}`;
}

function Guests({ attendees }: { attendees: ReadonlyArray<CalendarAttendee> }) {
  const [expanded, setExpanded] = useState(false);
  const people = attendees.filter((attendee) => !attendee.resource);
  if (people.length === 0) return null;
  const shown = expanded ? people : people.slice(0, GUESTS_SHOWN);
  return (
    <Row icon={<UsersIcon />}>
      <p className="text-foreground">{guestSummary(people)}</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {shown.map((attendee) => (
          <li key={attendee.email} className="flex min-w-0 items-center gap-2 text-xs">
            <ResponseIcon status={attendee.responseStatus} />
            <span className="min-w-0 truncate text-foreground">
              {attendee.displayName || attendee.email}
            </span>
            {attendee.organizer ? (
              <span className="shrink-0 text-muted-foreground">Organizer</span>
            ) : attendee.optional ? (
              <span className="shrink-0 text-muted-foreground">Optional</span>
            ) : null}
          </li>
        ))}
      </ul>
      {people.length > GUESTS_SHOWN ? (
        <Button size="xs" variant="ghost-muted" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show fewer" : `Show all ${people.length}`}
        </Button>
      ) : null}
    </Row>
  );
}

function IconAction({
  label,
  shortcut,
  onClick,
  disabled,
  variant = "ghost-muted",
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "ghost-muted" | "ghost-destructive";
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant={variant}
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {label}
        {shortcut ? ` (${shortcut})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

function PopoverBody({
  environmentId,
  instance,
  calendar,
  account,
  timeZone,
  hourFormat,
}: {
  environmentId: EnvironmentId;
  instance: CalendarEventInstance;
  calendar: Calendar | undefined;
  account: CalendarAccount | undefined;
  timeZone: string;
  hourFormat: HourFormat;
}) {
  const closePopover = useCalendarUi((state) => state.closePopover);
  const openEditor = useCalendarUi((state) => state.openEditor);
  const pending = isPendingEventId(instance.eventId);
  const query = useEnvironmentQuery(
    pending
      ? null
      : calendarEnvironment.eventDetails({
          environmentId,
          input: { calendarId: CalendarId.make(instance.calendarId), eventId: instance.eventId },
        }),
  );
  const details: CalendarEventDetails | null = query.data;
  // The event changed (here or elsewhere): read its details again.
  const shownInstance = useRef(instance);
  useEffect(() => {
    if (shownInstance.current === instance) return;
    shownInstance.current = instance;
    query.refresh();
  }, [instance, query]);

  const color = instance.color ?? calendar?.color;
  const readOnly = instance.readOnly === true || pending;
  const edit = () => {
    openEditor({
      mode: "edit",
      calendarId: instance.calendarId,
      eventId: instance.eventId,
      instance,
    });
  };
  const remove = async () => {
    closePopover();
    await deleteCalendarEvent(environmentId, instance, {
      askToNotify:
        (details?.organizer?.self ?? false) &&
        (details?.attendees.some((attendee) => !attendee.self && !attendee.resource) ?? false),
    });
  };
  const location = details?.location ?? instance.location;
  const rawDescription = details?.description ?? "";
  const description = useMemo(
    () => (rawDescription ? descriptionText(rawDescription) : ""),
    [rawDescription],
  );
  const recurrence =
    details?.recurrence && details.recurrence.length > 0
      ? describeRecurrence(details.recurrence, {
          start: details.originalStart ?? instance.start,
          allDay: instance.allDay === true,
          timeZone: details.timeZone ?? timeZone,
        })
      : null;
  const zoneLine = describeEventZone(instance, details?.timeZone, timeZone, hourFormat);

  return (
    <div
      className="flex flex-col gap-3"
      onKeyDown={(event) => {
        if (isEditableFocused(event.target) || event.metaKey || event.ctrlKey || event.altKey)
          return;
        if ((event.key === "e" || event.key === "E") && !readOnly) {
          event.preventDefault();
          edit();
        } else if ((event.key === "Delete" || event.key === "Backspace") && !readOnly) {
          event.preventDefault();
          void remove();
        }
      }}
    >
      <div className="flex items-center justify-end gap-0.5 -me-1.5 -mt-1.5">
        <IconAction label="Edit" shortcut="E" disabled={readOnly} onClick={edit}>
          <PencilIcon />
        </IconAction>
        <IconAction
          label="Duplicate"
          disabled={pending}
          onClick={() => {
            closePopover();
            void duplicateEvent(environmentId, instance, null, timeZone);
          }}
        >
          <CopyIcon />
        </IconAction>
        {details?.htmlLink ? (
          <IconAction
            label="Open in Google Calendar"
            onClick={() => void ensureLocalApi().shell.openExternal(details.htmlLink!)}
          >
            <ExternalLinkIcon />
          </IconAction>
        ) : null}
        <IconAction
          label="Delete"
          shortcut="Delete"
          variant="ghost-destructive"
          disabled={readOnly}
          onClick={() => void remove()}
        >
          <Trash2Icon />
        </IconAction>
        <IconAction label="Close" shortcut="Esc" onClick={closePopover}>
          <XIcon />
        </IconAction>
      </div>
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-1.5 size-3 shrink-0 rounded-sm"
          style={{ backgroundColor: color }}
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-base leading-snug font-semibold text-foreground wrap-break-word">
            {instance.title || "(No title)"}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {describeEventWhen(instance, timeZone, hourFormat)}
          </p>
          {zoneLine ? <p className="text-xs text-muted-foreground">{zoneLine}</p> : null}
          {recurrence ? (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              <RepeatIcon className="size-3" aria-hidden />
              {recurrence}
            </p>
          ) : null}
        </div>
      </div>
      {details?.conference ? (
        <Row icon={<VideoIcon />}>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => void ensureLocalApi().shell.openExternal(details.conference!.url)}
            >
              Join {details.conference.name}
            </Button>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {details.conference.url.replace(/^https?:\/\//, "")}
            </span>
          </div>
        </Row>
      ) : null}
      {location ? (
        <Row icon={<MapPinIcon />}>
          {locationHref(location) ? (
            <a
              href={locationHref(location)!}
              target="_blank"
              rel="noreferrer"
              className="wrap-break-word text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
            >
              {isHttpUrl(location) ? location.replace(/^https?:\/\//, "") : location}
            </a>
          ) : (
            <span className="wrap-break-word text-foreground">{location}</span>
          )}
        </Row>
      ) : null}
      {details && details.attendees.length > 0 ? <Guests attendees={details.attendees} /> : null}
      {description ? (
        <Row icon={<AlignLeftIcon />}>
          <p className="line-clamp-6 text-sm whitespace-pre-line wrap-break-word text-foreground">
            {description}
          </p>
        </Row>
      ) : null}
      <Row
        icon={
          <span
            aria-hidden
            className="size-2.5 rounded-full"
            style={{ backgroundColor: calendar?.color }}
          />
        }
      >
        <p className="truncate text-xs text-muted-foreground">
          {calendar?.name ?? "Calendar"}
          {account ? ` · ${account.email}` : ""}
          {instance.free ? " · Free" : ""}
        </p>
      </Row>
      {details?.canRespond ? (
        <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
          <span className="text-sm text-foreground">Going?</span>
          <ToggleGroup
            aria-label="Your reply"
            variant="segmented"
            value={
              instance.response && instance.response !== "needsAction" ? [instance.response] : []
            }
            onValueChange={(next) => {
              const response = next[0];
              if (response === "accepted" || response === "tentative" || response === "declined") {
                void respondToEvent(environmentId, instance, response);
              }
            }}
          >
            <Toggle value="accepted">Yes</Toggle>
            <Toggle value="tentative">Maybe</Toggle>
            <Toggle value="declined">No</Toggle>
          </ToggleGroup>
        </div>
      ) : null}
    </div>
  );
}

/** The details popover for the selected event; mounted once by the calendar page. */
export function EventPopover({
  environmentId,
  instances,
  calendars,
  accounts,
  timeZone,
  hourFormat,
}: {
  environmentId: EnvironmentId;
  instances: ReadonlyArray<CalendarEventInstance>;
  calendars: ReadonlyMap<string, Calendar>;
  accounts: ReadonlyArray<CalendarAccount>;
  timeZone: string;
  hourFormat: HourFormat;
}) {
  const popover = useCalendarUi((state) => state.popover);
  const closePopover = useCalendarUi((state) => state.closePopover);
  const key = popover
    ? calendarEventKey(popover.instance.calendarId, popover.instance.eventId)
    : null;
  // Show the live instance, so a change made elsewhere shows here too.
  const instance = useMemo(
    () =>
      key === null
        ? null
        : (instances.find(
            (candidate) => calendarEventKey(candidate.calendarId, candidate.eventId) === key,
          ) ??
          popover?.instance ??
          null),
    [instances, key, popover?.instance],
  );
  const anchor = useMemo(() => {
    if (key === null || instance === null) return null;
    const stored = popover?.anchor ?? null;
    // The block re-mounts when the event moves to another day, and an event opened from
    // search renders once its week loads; find it again whenever the instance changes.
    return () =>
      (stored?.isConnected ? stored : null) ??
      document.querySelector(`[data-event-key="${CSS.escape(key)}"]`) ??
      document.querySelector("[data-calendar-page]");
  }, [instance, key, popover?.anchor]);
  const openedFrom = popover?.anchor ?? null;
  // Focus goes back to the event's block (or wherever it is drawn now), unless the popover
  // closed into the editor, which takes focus itself.
  const finalFocus = () => {
    if (readCalendarUi().editor !== null) return false;
    return (
      (openedFrom instanceof HTMLElement && openedFrom.isConnected
        ? openedFrom
        : key === null
          ? null
          : document.querySelector<HTMLElement>(`[data-event-key="${CSS.escape(key)}"]`)) ?? true
    );
  };
  const calendar = instance ? calendars.get(instance.calendarId) : undefined;
  const account = calendar
    ? accounts.find((candidate) => candidate.accountId === calendar.accountId)
    : undefined;
  return (
    <Popover
      open={instance !== null}
      onOpenChange={(open) => {
        if (!open) closePopover();
      }}
    >
      <PopoverPopup
        anchor={anchor}
        side="right"
        align="start"
        width="md"
        finalFocus={finalFocus}
        aria-label={instance ? `Event: ${instance.title || "(No title)"}` : "Event"}
        data-event-popover=""
        data-event-popover-key={key ?? undefined}
      >
        {instance ? (
          <PopoverBody
            key={key}
            environmentId={environmentId}
            instance={instance}
            calendar={calendar}
            account={account}
            timeZone={timeZone}
            hourFormat={hourFormat}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
