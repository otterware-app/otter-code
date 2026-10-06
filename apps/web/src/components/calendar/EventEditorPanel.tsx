/**
 * The event editor, a panel on the right (Notion Calendar style) for creating and editing.
 * Creating shows the new event in the grid while it is being filled in. Saving a recurring
 * event asks which occurrences it applies to; changes to events with guests ask whether to
 * notify them. Esc cancels, Mod+Enter saves; focus goes back to the event afterwards.
 */
import type { HourFormat } from "@t3tools/client-runtime/calendar/format";
import { withRange } from "@t3tools/client-runtime/calendar/optimistic";
import {
  type Calendar,
  type CalendarAccount,
  type CalendarDirectory,
  type CalendarEventDetails,
  type CalendarEventInstance,
  type EnvironmentId,
  CalendarId,
  calendarEventKey,
} from "@t3tools/contracts";
import { describeRecurrence } from "@t3tools/shared/calendar/recurrence";
import {
  AlignLeftIcon,
  CalendarIcon,
  ClockIcon,
  GlobeIcon,
  LockIcon,
  MapPinIcon,
  RepeatIcon,
  UsersIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { isMacPlatform } from "../../lib/utils";
import { calendarEnvironment, calendarOptimistic } from "../../state/calendar";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { createCalendarEvent, deleteCalendarEvent, saveCalendarEvent } from "./calendarActions";
import { type EditorTarget, type EventDraft, useCalendarUi } from "./calendarUiStore";
import { defaultCalendarId } from "./calendarView.logic";
import {
  type EditorForm,
  type RepeatChoice,
  createInput,
  editorChanges,
  formForEvent,
  formRange,
  formTimes,
  repeatChoiceLabel,
  withEnd,
  withStart,
} from "./eventEditor.logic";
import { DateField, GuestsField, TimeField, TimeZoneField } from "./EventEditorFields";

const REPEAT_CHOICES: ReadonlyArray<RepeatChoice> = [
  "none",
  "daily",
  "weekdays",
  "weekly",
  "monthlyDay",
  "monthlyWeekday",
  "yearly",
];

function FieldRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="mt-1.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4"
              aria-label={label}
            />
          }
        >
          {icon}
        </TooltipTrigger>
        <TooltipPopup side="left">{label}</TooltipPopup>
      </Tooltip>
      <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
    </div>
  );
}

function writableCalendars(calendars: ReadonlyArray<Calendar>) {
  return calendars.filter(
    (calendar) => calendar.accessRole === "owner" || calendar.accessRole === "writer",
  );
}

function CalendarSelect({
  value,
  calendars,
  accounts,
  onChange,
}: {
  value: string;
  calendars: ReadonlyArray<Calendar>;
  accounts: ReadonlyArray<CalendarAccount>;
  onChange: (calendarId: string) => void;
}) {
  const selected = calendars.find((calendar) => calendar.calendarId === value);
  const groups = accounts
    .map((account) => ({
      account,
      calendars: calendars.filter((calendar) => calendar.accountId === account.accountId),
    }))
    .filter((group) => group.calendars.length > 0);
  return (
    <Select value={value} onValueChange={(next) => typeof next === "string" && onChange(next)}>
      <SelectTrigger size="sm" aria-label="Calendar">
        <SelectValue>
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: selected?.color }}
            />
            <span className="truncate">{selected?.name ?? "Choose a calendar"}</span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {groups.map((group) => (
          <SelectGroup key={group.account.accountId}>
            <SelectGroupLabel>{group.account.email}</SelectGroupLabel>
            {group.calendars.map((calendar) => (
              <SelectItem key={calendar.calendarId} value={calendar.calendarId}>
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: calendar.color }}
                  />
                  <span className="truncate">{calendar.name}</span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectPopup>
    </Select>
  );
}

function focusEventOrGrid(key: string | null) {
  requestAnimationFrame(() => {
    const target =
      (key === null
        ? null
        : document.querySelector<HTMLElement>(`[data-event-key="${CSS.escape(key)}"]`)) ??
      document.querySelector<HTMLElement>("[data-calendar-surface]");
    target?.focus({ preventScroll: true });
  });
}

function EventForm({
  environmentId,
  directory,
  mode,
  initial,
  draft,
  instance,
  details,
  timeZone,
  hourFormat,
}: {
  environmentId: EnvironmentId;
  directory: CalendarDirectory;
  mode: "create" | "edit";
  initial: EditorForm;
  /** The new event's draft, moved when its block is dragged in the grid. */
  draft: EventDraft | null;
  /** The event being edited. */
  instance: CalendarEventInstance | null;
  details: CalendarEventDetails | null;
  timeZone: string;
  hourFormat: HourFormat;
}) {
  const closeEditor = useCalendarUi((state) => state.closeEditor);
  // The form starts from the event as it was when the editor opened.
  const [initialForm] = useState(initial);
  const [form, setForm] = useState(initialForm);
  // Dragging the draft's block in the grid moves the form's times with it.
  const [shownDraft, setShownDraft] = useState(draft);
  if (draft !== shownDraft) {
    setShownDraft(draft);
    if (draft !== null) {
      setForm((current) => ({ ...current, ...formTimes(draft, current.timeZone) }));
    }
  }
  const draftId = draft?.id ?? "";
  const titleRef = useRef<HTMLInputElement>(null);
  const range = formRange(form);
  const existingRecurrence = details?.recurrence ?? [];
  const eventKey = instance ? calendarEventKey(instance.calendarId, instance.eventId) : null;
  const update = (patch: Partial<EditorForm>) => setForm((current) => ({ ...current, ...patch }));

  useEffect(() => {
    if (mode === "create") titleRef.current?.focus();
    else titleRef.current?.select();
  }, [mode]);

  // While creating, the new event shows in the grid where it will land.
  const draftCalendarId = form.calendarId;
  const draftTitle = form.title;
  const { start: draftStart, end: draftEnd, allDay: draftAllDay } = range;
  useEffect(() => {
    if (mode !== "create" || draftCalendarId === "" || draftId === "") return;
    const store = calendarOptimistic(environmentId);
    const id = store.apply({
      upsert: [
        withRange(
          {
            calendarId: CalendarId.make(draftCalendarId),
            eventId: draftId,
            title: draftTitle,
            start: 0,
            end: 0,
          },
          { start: draftStart, end: draftEnd, allDay: draftAllDay },
        ),
      ],
    });
    return () => store.settle(id);
  }, [
    draftAllDay,
    draftCalendarId,
    draftEnd,
    draftId,
    draftStart,
    draftTitle,
    environmentId,
    mode,
  ]);

  const writable = writableCalendars(directory.calendars);
  // Google moves events only between calendars of the same account.
  const eventAccount = directory.calendars.find(
    (calendar) => calendar.calendarId === initialForm.calendarId,
  )?.accountId;
  const eventProvider = directory.accounts.find(
    (account) => account.accountId === eventAccount,
  )?.provider;
  const movable =
    mode === "edit" && eventProvider === "google"
      ? writable.filter((calendar) => calendar.accountId === eventAccount)
      : writable;
  // A new event is only worth keeping once something was typed into it.
  const dirty =
    mode === "create"
      ? form.title.trim() !== "" ||
        form.description.trim() !== "" ||
        form.location.trim() !== "" ||
        form.guests.length > 0
      : JSON.stringify(form) !== JSON.stringify(initialForm);
  const organizerSelf = details?.organizer?.self ?? mode === "create";
  const hasOtherGuests =
    form.guests.length > 0 ||
    (details?.attendees.some((attendee) => !attendee.self && !attendee.resource) ?? false);

  const cancel = async () => {
    if (
      dirty &&
      !(await ensureLocalApi().dialogs.confirm("Discard unsaved changes?", {
        variant: "destructive",
      }))
    ) {
      return;
    }
    closeEditor();
    focusEventOrGrid(eventKey);
  };

  const save = async () => {
    if (form.calendarId === "") return;
    if (mode === "create") {
      void createCalendarEvent(environmentId, createInput(form), range, draftId);
      closeEditor();
      focusEventOrGrid(null);
      return;
    }
    if (instance === null) return;
    const changes = editorChanges(initialForm, form, existingRecurrence);
    if (Object.keys(changes).length === 0) {
      closeEditor();
      focusEventOrGrid(eventKey);
      return;
    }
    const preview: CalendarEventInstance = {
      ...withRange(instance, range),
      title: form.title,
      calendarId: CalendarId.make(form.calendarId),
      ...(form.location ? { location: form.location } : {}),
      ...(form.free ? { free: true } : { free: false }),
    };
    const notifiable =
      changes.time !== undefined ||
      changes.title !== undefined ||
      changes.location !== undefined ||
      changes.description !== undefined ||
      changes.attendees !== undefined ||
      changes.recurrence !== undefined;
    await saveCalendarEvent(environmentId, instance, changes, {
      preview,
      recurrenceChanged: changes.recurrence !== undefined,
      askToNotify: organizerSelf && hasOtherGuests && notifiable,
      onConfirmed: () => {
        closeEditor();
        focusEventOrGrid(calendarEventKey(preview.calendarId, preview.eventId));
      },
    });
  };

  const remove = async () => {
    if (instance === null) return;
    const deleted = await deleteCalendarEvent(environmentId, instance, {
      askToNotify: organizerSelf && hasOtherGuests,
    });
    if (deleted) {
      closeEditor();
      focusEventOrGrid(null);
    }
  };

  const repeatAnchor = { start: range.start, allDay: form.allDay, timeZone: form.timeZone };
  const repeatChoices: ReadonlyArray<RepeatChoice> =
    initialForm.repeat === "custom" ? [...REPEAT_CHOICES, "custom"] : REPEAT_CHOICES;
  const customLabel =
    existingRecurrence.length > 0
      ? describeRecurrence(existingRecurrence, {
          start: details?.originalStart ?? range.start,
          allDay: form.allDay,
          timeZone: form.timeZone,
        })
      : "Custom";
  const modLabel = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl+";

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void save();
        } else if (
          event.key === "Escape" &&
          target.getAttribute("aria-expanded") !== "true" &&
          !event.defaultPrevented
        ) {
          event.preventDefault();
          event.stopPropagation();
          void cancel();
        }
      }}
    >
      <header className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {mode === "create" ? "New event" : "Edit event"}
        </h2>
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label="Close editor"
          onClick={() => void cancel()}
        >
          <XIcon />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-1 pb-4">
        <input
          ref={titleRef}
          value={form.title}
          aria-label="Title"
          placeholder="Add title"
          className="w-full bg-transparent text-xl font-semibold tracking-tight text-foreground outline-none placeholder:text-muted-foreground"
          onChange={(event) => update({ title: event.target.value })}
        />
        <FieldRow icon={<ClockIcon />} label="Time">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              size="sm"
              checked={form.allDay}
              onCheckedChange={(allDay) => update({ allDay })}
            />
            All day
          </label>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,6.5rem)] gap-1.5">
            <DateField
              label="Start date"
              day={form.startDay}
              onChange={(day) =>
                setForm((current) => withStart(current, day, current.startMinutes))
              }
            />
            {form.allDay ? null : (
              <TimeField
                label="Start time"
                minutes={form.startMinutes}
                hourFormat={hourFormat}
                onCommit={(minutes) =>
                  setForm((current) => withStart(current, current.startDay, minutes))
                }
              />
            )}
            <DateField
              label="End date"
              day={form.endDay}
              onChange={(day) => setForm((current) => withEnd(current, day, current.endMinutes))}
            />
            {form.allDay ? null : (
              <TimeField
                label="End time"
                minutes={form.endMinutes}
                from={form.startMinutes}
                hourFormat={hourFormat}
                onCommit={(minutes) =>
                  setForm((current) =>
                    withEnd(
                      current,
                      minutes <= current.startMinutes ? current.startDay + 1 : current.startDay,
                      minutes,
                    ),
                  )
                }
              />
            )}
          </div>
        </FieldRow>
        {form.allDay ? null : (
          <FieldRow icon={<GlobeIcon />} label="Time zone">
            <TimeZoneField
              label="Time zone"
              zone={form.timeZone}
              at={range.start}
              onChange={(zone) => update({ timeZone: zone })}
            />
            {form.timeZone !== timeZone ? (
              <p className="text-xs text-muted-foreground">
                Your calendar shows {timeZone.replace(/_/g, " ")}.
              </p>
            ) : null}
          </FieldRow>
        )}
        <FieldRow icon={<RepeatIcon />} label="Repeat">
          <Select
            value={form.repeat}
            onValueChange={(next) => update({ repeat: next as RepeatChoice })}
          >
            <SelectTrigger size="sm" aria-label="Repeat">
              <SelectValue>
                {form.repeat === "custom"
                  ? customLabel
                  : repeatChoiceLabel(form.repeat, repeatAnchor)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {repeatChoices.map((choice) => (
                <SelectItem key={choice} value={choice}>
                  {choice === "custom" ? customLabel : repeatChoiceLabel(choice, repeatAnchor)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </FieldRow>
        <FieldRow icon={<CalendarIcon />} label="Calendar">
          <CalendarSelect
            value={form.calendarId}
            calendars={movable}
            accounts={directory.accounts}
            onChange={(calendarId) => update({ calendarId })}
          />
        </FieldRow>
        <FieldRow icon={<MapPinIcon />} label="Location">
          <Input
            size="sm"
            placeholder="Add location"
            aria-label="Location"
            value={form.location}
            onChange={(event) => update({ location: event.target.value })}
          />
        </FieldRow>
        <FieldRow icon={<UsersIcon />} label="Guests">
          <GuestsField
            guests={form.guests}
            known={details?.attendees ?? []}
            onChange={(guests) => update({ guests })}
          />
        </FieldRow>
        <FieldRow icon={<VideoIcon />} label="Video call">
          {details?.conference ? (
            <p className="truncate pt-1 text-sm text-foreground">
              {details.conference.name} ·{" "}
              <span className="text-muted-foreground">
                {details.conference.url.replace(/^https?:\/\//, "")}
              </span>
            </p>
          ) : (
            <label className="flex items-center gap-2 pt-1 text-sm text-foreground">
              <Switch
                size="sm"
                checked={form.addConference}
                onCheckedChange={(addConference) => update({ addConference })}
              />
              Add Google Meet
            </label>
          )}
        </FieldRow>
        <FieldRow icon={<LockIcon />} label="Availability and visibility">
          <div className="grid grid-cols-2 gap-1.5">
            <Select
              value={form.free ? "free" : "busy"}
              onValueChange={(next) => update({ free: next === "free" })}
            >
              <SelectTrigger size="sm" aria-label="Show as">
                <SelectValue>{form.free ? "Free" : "Busy"}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="busy">Busy</SelectItem>
                <SelectItem value="free">Free</SelectItem>
              </SelectPopup>
            </Select>
            <Select
              value={form.visibility}
              onValueChange={(next) => update({ visibility: next as EditorForm["visibility"] })}
            >
              <SelectTrigger size="sm" aria-label="Visibility">
                <SelectValue>
                  {form.visibility === "default"
                    ? "Default visibility"
                    : form.visibility === "public"
                      ? "Public"
                      : "Private"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="default">Default visibility</SelectItem>
                <SelectItem value="public">Public</SelectItem>
                <SelectItem value="private">Private</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        </FieldRow>
        <FieldRow icon={<AlignLeftIcon />} label="Description">
          <Textarea
            size="sm"
            placeholder="Add description"
            aria-label="Description"
            value={form.description}
            onChange={(event) => update({ description: event.target.value })}
          />
        </FieldRow>
      </div>
      <footer className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2.5">
        {mode === "edit" ? (
          <Button variant="ghost-destructive" size="sm" onClick={() => void remove()}>
            Delete
          </Button>
        ) : null}
        <div className="ms-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void cancel()}>
            Cancel
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={<Button type="submit" size="sm" disabled={form.calendarId === ""} />}
            >
              Save
            </TooltipTrigger>
            <TooltipPopup side="top">Save ({modLabel}Enter)</TooltipPopup>
          </Tooltip>
        </div>
      </footer>
    </form>
  );
}

function CreateEditor({
  environmentId,
  directory,
  draft,
  timeZone,
}: {
  environmentId: EnvironmentId;
  directory: CalendarDirectory;
  draft: EventDraft;
  timeZone: string;
}) {
  const [initial] = useState((): EditorForm => ({
    title: draft.title ?? "",
    ...formTimes(draft, timeZone),
    timeZone,
    repeat: "none",
    calendarId:
      draft.calendarId ??
      defaultCalendarId(directory.calendars, directory.preferences.defaultCalendarId) ??
      "",
    location: "",
    description: "",
    guests: [],
    addConference: false,
    free: false,
    visibility: "default",
  }));
  return (
    <EventForm
      environmentId={environmentId}
      directory={directory}
      mode="create"
      initial={initial}
      draft={draft}
      instance={null}
      details={null}
      timeZone={timeZone}
      hourFormat={directory.preferences.hourFormat}
    />
  );
}

function EditEditor({
  environmentId,
  directory,
  target,
  instance,
  timeZone,
}: {
  environmentId: EnvironmentId;
  directory: CalendarDirectory;
  target: Extract<EditorTarget, { mode: "edit" }>;
  instance: CalendarEventInstance;
  timeZone: string;
}) {
  const query = useEnvironmentQuery(
    calendarEnvironment.eventDetails({
      environmentId,
      input: { calendarId: CalendarId.make(target.calendarId), eventId: target.eventId },
    }),
  );
  const details = query.data;
  if (details === null) {
    return (
      <div className="flex flex-1 flex-col gap-2 p-4">
        <p className="text-sm text-muted-foreground">{query.error ?? "Loading event…"}</p>
      </div>
    );
  }
  return (
    <EventForm
      environmentId={environmentId}
      directory={directory}
      mode="edit"
      initial={formForEvent(instance, details, timeZone)}
      draft={null}
      instance={instance}
      details={details}
      timeZone={timeZone}
      hourFormat={directory.preferences.hourFormat}
    />
  );
}

/** The editor panel for the open create or edit; renders nothing when none is open. */
export function EventEditorPanel({
  environmentId,
  directory,
  instances,
  timeZone,
}: {
  environmentId: EnvironmentId;
  directory: CalendarDirectory;
  instances: ReadonlyArray<CalendarEventInstance>;
  timeZone: string;
}) {
  const editor = useCalendarUi((state) => state.editor);
  if (editor === null) return null;
  const key =
    editor.mode === "edit"
      ? `edit:${editor.calendarId}/${editor.eventId}`
      : `create:${editor.draft.id}`;
  const live =
    editor.mode === "edit"
      ? (instances.find(
          (candidate) =>
            candidate.calendarId === editor.calendarId && candidate.eventId === editor.eventId,
        ) ?? editor.instance)
      : null;
  return (
    <aside
      aria-label={editor.mode === "create" ? "New event" : "Edit event"}
      data-event-editor=""
      className="flex h-full w-90 shrink-0 flex-col border-s border-border bg-background max-md:absolute max-md:inset-y-0 max-md:end-0 max-md:z-30 max-md:w-full"
    >
      {editor.mode === "create" ? (
        <CreateEditor
          key={key}
          environmentId={environmentId}
          directory={directory}
          draft={editor.draft}
          timeZone={timeZone}
        />
      ) : (
        <EditEditor
          key={key}
          environmentId={environmentId}
          directory={directory}
          target={editor}
          instance={live ?? editor.instance}
          timeZone={timeZone}
        />
      )}
    </aside>
  );
}
