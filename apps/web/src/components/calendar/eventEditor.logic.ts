/**
 * The event editor's model: a form of civil dates and wall-clock minutes in the event's zone,
 * how it reads from an event, and the smallest update it turns into. Pure, so it is tested
 * without rendering.
 */
import {
  type CalendarCreateEventInput,
  type CalendarEventDetails,
  type CalendarEventInstance,
  type CalendarEventTimeInput,
  type CalendarUpdateEventInput,
  CalendarId,
} from "@t3tools/contracts";
import {
  type RepeatOptions,
  buildRecurrenceRule,
  describeRecurrence,
  repeatOptionsOf,
} from "@t3tools/shared/calendar/recurrence";
import {
  DAY_MS,
  type DayNumber,
  MINUTE_MS,
  formatDayNumber,
  formatZonedIso,
  fromZoned,
  toZoned,
  weekday,
} from "@t3tools/shared/calendar/time";

export const TIME_STEP_MINUTES = 15;

// ── Typed times ──────────────────────────────────────────────────────

/**
 * Reads a typed time as minutes after midnight: "9", "930", "9:30", "9.30", "9am", "9:30 pm",
 * "21:15", "noon", "midnight". Null when it is not a time.
 */
export function parseTimeText(text: string): number | null {
  const value = text.trim().toLowerCase().replace(/\s+/g, "");
  if (value === "noon") return 12 * 60;
  if (value === "midnight") return 0;
  const match = /^(\d{1,2})(?:[:.h]?(\d{2}))?(a|p|am|pm|a\.m\.|p\.m\.)?$/.exec(value);
  if (match === null) return null;
  let hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  const period = match[3]?.[0];
  if (minutes > 59) return null;
  if (period !== undefined) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (period === "p" ? 12 : 0);
  } else if (hours > 23) {
    return null;
  }
  return hours * 60 + minutes;
}

// ── Repeat choices ───────────────────────────────────────────────────

export type RepeatChoice =
  | "none"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthlyDay"
  | "monthlyWeekday"
  | "yearly"
  /** A rule the picker cannot show; kept as it is. */
  | "custom";

export interface RepeatAnchor {
  readonly start: number;
  readonly allDay: boolean;
  readonly timeZone: string;
}

function anchorDay(anchor: RepeatAnchor): DayNumber {
  return anchor.allDay
    ? Math.floor(anchor.start / DAY_MS)
    : toZoned(anchor.start, anchor.timeZone).day;
}

/** The picker's choice for an event's recurrence lines. */
export function repeatChoiceOf(
  recurrence: ReadonlyArray<string>,
  anchor: RepeatAnchor,
): RepeatChoice {
  if (!recurrence.some((line) => line.toUpperCase().startsWith("RRULE"))) {
    return recurrence.length === 0 ? "none" : "custom";
  }
  const options = repeatOptionsOf(recurrence, anchor);
  if (
    options === null ||
    (options.interval ?? 1) !== 1 ||
    options.count !== undefined ||
    options.untilDay !== undefined
  ) {
    return "custom";
  }
  switch (options.freq) {
    case "DAILY":
      return "daily";
    case "WEEKLY": {
      const days = [...new Set(options.weekdays ?? [weekday(anchorDay(anchor))])].sort();
      if (days.join() === "1,2,3,4,5") return "weekdays";
      return days.length === 1 && days[0] === weekday(anchorDay(anchor)) ? "weekly" : "custom";
    }
    case "MONTHLY":
      return options.monthlyByWeekday ? "monthlyWeekday" : "monthlyDay";
    case "YEARLY":
      return "yearly";
  }
}

const CHOICE_OPTIONS: Readonly<Record<Exclude<RepeatChoice, "none" | "custom">, RepeatOptions>> = {
  daily: { freq: "DAILY" },
  weekdays: { freq: "WEEKLY", weekdays: [1, 2, 3, 4, 5] },
  weekly: { freq: "WEEKLY" },
  monthlyDay: { freq: "MONTHLY" },
  monthlyWeekday: { freq: "MONTHLY", monthlyByWeekday: true },
  yearly: { freq: "YEARLY" },
};

/**
 * The recurrence lines for a choice, anchored on the (possibly moved) start. Exception dates
 * of the existing rule are kept; "custom" keeps the existing lines as they are.
 */
export function recurrenceForChoice(
  choice: RepeatChoice,
  anchor: RepeatAnchor,
  existing: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (choice === "none") return [];
  if (choice === "custom") return existing;
  const options =
    choice === "weekly"
      ? { ...CHOICE_OPTIONS.weekly, weekdays: [weekday(anchorDay(anchor))] }
      : CHOICE_OPTIONS[choice];
  const rest = existing.filter((line) => !line.toUpperCase().startsWith("RRULE"));
  return [buildRecurrenceRule(options, anchor), ...rest];
}

/** Labels for the picker: "Weekly on Wednesday", "Monthly on the last Friday". */
export function repeatChoiceLabel(choice: RepeatChoice, anchor: RepeatAnchor): string {
  if (choice === "none") return "Does not repeat";
  if (choice === "custom") return "Custom";
  const label = describeRecurrence(recurrenceForChoice(choice, anchor, []), anchor);
  return choice === "weekdays" ? `${label} (Monday to Friday)` : label;
}

// ── The form ─────────────────────────────────────────────────────────

export interface EditorForm {
  readonly title: string;
  readonly allDay: boolean;
  readonly startDay: DayNumber;
  /** Minutes after midnight in `timeZone` (ignored for all-day events). */
  readonly startMinutes: number;
  /** Inclusive last day for all-day events; the end's day for timed ones. */
  readonly endDay: DayNumber;
  readonly endMinutes: number;
  readonly timeZone: string;
  readonly repeat: RepeatChoice;
  readonly calendarId: string;
  readonly location: string;
  readonly description: string;
  readonly guests: ReadonlyArray<string>;
  readonly addConference: boolean;
  readonly free: boolean;
  readonly visibility: "default" | "public" | "private";
}

/** The form for a range: all-day ranges are UTC-midnight dates, timed ones instants. */
export function formTimes(
  range: { readonly start: number; readonly end: number; readonly allDay: boolean },
  timeZone: string,
): Pick<EditorForm, "allDay" | "startDay" | "startMinutes" | "endDay" | "endMinutes"> {
  if (range.allDay) {
    const startDay = Math.floor(range.start / DAY_MS);
    return {
      allDay: true,
      startDay,
      startMinutes: 9 * 60,
      endDay: Math.max(startDay, Math.floor(range.end / DAY_MS) - 1),
      endMinutes: 10 * 60,
    };
  }
  const start = toZoned(range.start, timeZone);
  const end = toZoned(range.end, timeZone);
  return {
    allDay: false,
    startDay: start.day,
    startMinutes: Math.round(start.minutes),
    endDay: end.day,
    endMinutes: Math.round(end.minutes),
  };
}

/** The form's range as epoch ms (all-day: UTC midnights, end exclusive). */
export function formRange(form: EditorForm): { start: number; end: number; allDay: boolean } {
  if (form.allDay) {
    return {
      start: form.startDay * DAY_MS,
      end: (Math.max(form.startDay, form.endDay) + 1) * DAY_MS,
      allDay: true,
    };
  }
  const start = fromZoned(form.startDay, form.startMinutes, form.timeZone);
  const end = fromZoned(form.endDay, form.endMinutes, form.timeZone);
  return { start, end: Math.max(start + MINUTE_MS, end), allDay: false };
}

function formTimeInput(form: EditorForm): CalendarEventTimeInput {
  const range = formRange(form);
  if (range.allDay) {
    return {
      allDay: true,
      start: formatDayNumber(form.startDay),
      end: formatDayNumber(Math.max(form.startDay, form.endDay) + 1),
    };
  }
  return {
    allDay: false,
    start: formatZonedIso(range.start, form.timeZone),
    end: formatZonedIso(range.end, form.timeZone),
    timeZone: form.timeZone,
  };
}

/** Moves the start and keeps the duration, like every calendar does. */
export function withStart(form: EditorForm, startDay: DayNumber, startMinutes: number): EditorForm {
  if (form.allDay) {
    const length = form.endDay - form.startDay;
    return { ...form, startDay, endDay: startDay + length };
  }
  const previous = formRange(form);
  const start = fromZoned(startDay, startMinutes, form.timeZone);
  const end = toZoned(start + (previous.end - previous.start), form.timeZone);
  return {
    ...form,
    startDay,
    startMinutes,
    endDay: end.day,
    endMinutes: Math.round(end.minutes),
  };
}

/** Sets the end; an end before the start moves to the next valid time after it. */
export function withEnd(form: EditorForm, endDay: DayNumber, endMinutes: number): EditorForm {
  if (form.allDay) return { ...form, endDay: Math.max(form.startDay, endDay) };
  const start = fromZoned(form.startDay, form.startMinutes, form.timeZone);
  let end = fromZoned(endDay, endMinutes, form.timeZone);
  // A time before the start on the same day means the next day, like "11 PM – 1 AM".
  if (end <= start) end += DAY_MS;
  const zoned = toZoned(end, form.timeZone);
  return { ...form, endDay: zoned.day, endMinutes: Math.round(zoned.minutes) };
}

/** The editor's starting form for an event and its details. */
export function formForEvent(
  instance: CalendarEventInstance,
  details: CalendarEventDetails,
  viewZone: string,
): EditorForm {
  const timeZone = details.timeZone ?? viewZone;
  const allDay = instance.allDay === true;
  const recurrence = details.recurrence ?? [];
  return {
    title: instance.title,
    ...formTimes({ start: instance.start, end: instance.end, allDay }, timeZone),
    timeZone,
    repeat: repeatChoiceOf(recurrence, {
      start: details.originalStart ?? instance.start,
      allDay,
      timeZone,
    }),
    calendarId: instance.calendarId,
    location: details.location ?? "",
    description: details.description,
    guests: details.attendees
      .filter((attendee) => !attendee.self && !attendee.organizer && !attendee.resource)
      .map((attendee) => attendee.email),
    addConference: false,
    free: instance.free === true,
    visibility:
      details.visibility === "public" || details.visibility === "private"
        ? details.visibility
        : "default",
  };
}

function sameList(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Only what the user changed, so a save never overwrites edits made elsewhere. */
export function editorChanges(
  initial: EditorForm,
  form: EditorForm,
  existingRecurrence: ReadonlyArray<string>,
): Omit<CalendarUpdateEventInput, "calendarId" | "eventId" | "scope" | "sendUpdates"> {
  const timeChanged =
    initial.allDay !== form.allDay ||
    initial.startDay !== form.startDay ||
    initial.endDay !== form.endDay ||
    initial.timeZone !== form.timeZone ||
    (!form.allDay &&
      (initial.startMinutes !== form.startMinutes || initial.endMinutes !== form.endMinutes));
  const range = formRange(form);
  const repeatChanged =
    initial.repeat !== form.repeat ||
    (form.repeat !== "none" && form.repeat !== "custom" && timeChanged);
  return {
    ...(initial.title !== form.title ? { title: form.title } : {}),
    ...(timeChanged ? { time: formTimeInput(form) } : {}),
    ...(repeatChanged
      ? {
          recurrence: [
            ...recurrenceForChoice(
              form.repeat,
              { start: range.start, allDay: form.allDay, timeZone: form.timeZone },
              existingRecurrence,
            ),
          ],
        }
      : {}),
    ...(initial.calendarId !== form.calendarId
      ? { targetCalendarId: CalendarId.make(form.calendarId) }
      : {}),
    ...(initial.location !== form.location ? { location: form.location } : {}),
    ...(initial.description !== form.description ? { description: form.description } : {}),
    ...(!sameList(initial.guests, form.guests) ? { attendees: [...form.guests] } : {}),
    ...(form.addConference && !initial.addConference ? { addConference: true } : {}),
    ...(initial.free !== form.free ? { free: form.free } : {}),
    ...(initial.visibility !== form.visibility ? { visibility: form.visibility } : {}),
  };
}

/** A new event's create input from the form. */
export function createInput(form: EditorForm): CalendarCreateEventInput {
  const range = formRange(form);
  const recurrence = recurrenceForChoice(
    form.repeat,
    { start: range.start, allDay: form.allDay, timeZone: form.timeZone },
    [],
  );
  return {
    calendarId: CalendarId.make(form.calendarId),
    time: formTimeInput(form),
    title: form.title,
    ...(form.description ? { description: form.description } : {}),
    ...(form.location ? { location: form.location } : {}),
    ...(form.guests.length > 0 ? { attendees: [...form.guests] } : {}),
    ...(recurrence.length > 0 ? { recurrence: [...recurrence] } : {}),
    ...(form.addConference ? { addConference: true } : {}),
    ...(form.free ? { free: true } : {}),
    ...(form.visibility !== "default" ? { visibility: form.visibility } : {}),
  };
}

/** Loose email check for the guest field: something@something.tld. */
export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
