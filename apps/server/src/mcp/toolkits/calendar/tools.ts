/**
 * The agent's calendar tools. Each one calls `CalendarService`, the same service the RPC
 * handlers call, so an agent's change reaches every client like a click does.
 *
 * Times: inputs take ISO 8601 with an offset (`2026-10-01T09:00:00+02:00`); a time without an
 * offset, or a bare date for ranges, is read in the user's zone. Outputs give timed events as ISO
 * with the user's offset and all-day events as `YYYY-MM-DD` dates with an exclusive end.
 */
import {
  CalendarAccessRole,
  CalendarAccountStatus,
  CalendarChangeScope,
  CalendarError,
  CalendarEventId,
  CalendarId,
  CalendarProviderKind,
  CalendarResponseStatus,
  CalendarSendUpdates,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

/** How many events `calendar_list_events` returns before it says the list was cut. */
export const LIST_EVENTS_LIMIT = 300;

const TIME_NOTE =
  "Times are ISO 8601; without an offset they are in timeZone, else the user's time zone. Pass timeZone as the zone the app's context block names, so times read the way the user sees them.";

/** The zone to show times in and read offset-less times in: the one the user looks at. */
const ViewerTimeZone = Schema.optional(Schema.String);

const EventEntry = Schema.Struct({
  calendarId: CalendarId,
  calendar: Schema.String,
  eventId: CalendarEventId,
  seriesId: Schema.optional(CalendarEventId),
  title: Schema.String,
  start: Schema.String,
  end: Schema.String,
  allDay: Schema.optional(Schema.Boolean),
  location: Schema.optional(Schema.String),
  response: Schema.optional(CalendarResponseStatus),
  free: Schema.optional(Schema.Boolean),
  tentative: Schema.optional(Schema.Boolean),
  readOnly: Schema.optional(Schema.Boolean),
});

const EventDetail = Schema.Struct({
  ...EventEntry.fields,
  timeZone: Schema.optional(Schema.String),
  description: Schema.String,
  repeats: Schema.optional(Schema.String),
  recurrence: Schema.optional(Schema.Array(Schema.String)),
  organizer: Schema.optional(Schema.String),
  attendees: Schema.Array(
    Schema.Struct({
      email: Schema.String,
      name: Schema.optional(Schema.String),
      response: CalendarResponseStatus,
      organizer: Schema.optional(Schema.Boolean),
      self: Schema.optional(Schema.Boolean),
      optional: Schema.optional(Schema.Boolean),
    }),
  ),
  videoCall: Schema.optional(Schema.String),
  canRespond: Schema.Boolean,
  link: Schema.optional(Schema.String),
});

const ListAccountsTool = Tool.make("calendar_list_accounts", {
  description:
    "List the user's calendar accounts and their calendars (ids, names, colors, whether shown, access role), with the user's time zone and working hours. timeZone follows each device unless the user fixed one; pass the zone the app's context block names. Hidden calendars are not shown in the app but can still be read.",
  parameters: Schema.Struct({ timeZone: ViewerTimeZone }),
  success: Schema.Struct({
    timeZone: Schema.String,
    workingHours: Schema.Struct({
      start: Schema.String,
      end: Schema.String,
      days: Schema.Array(Schema.String),
    }),
    accounts: Schema.Array(
      Schema.Struct({
        accountId: Schema.String,
        email: Schema.String,
        provider: CalendarProviderKind,
        status: CalendarAccountStatus,
        error: Schema.optional(Schema.String),
        calendars: Schema.Array(
          Schema.Struct({
            calendarId: CalendarId,
            name: Schema.String,
            color: Schema.String,
            visible: Schema.Boolean,
            accessRole: CalendarAccessRole,
            primary: Schema.Boolean,
          }),
        ),
      }),
    ),
  }),
  failure: CalendarError,
})
  .annotate(Tool.Title, "List calendars")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListEventsTool = Tool.make("calendar_list_events", {
  description: `List events overlapping a time range, in start order, across the shown calendars (or the given calendarIds). Recurring events appear once per occurrence; eventId identifies the occurrence. Pass query to keep events whose title or location contains it. At most ${LIST_EVENTS_LIMIT} events; truncated says when more exist. ${TIME_NOTE}`,
  parameters: Schema.Struct({
    start: Schema.String,
    end: Schema.String,
    calendarIds: Schema.optional(Schema.Array(CalendarId)),
    query: Schema.optional(Schema.String),
    timeZone: ViewerTimeZone,
  }),
  success: Schema.Struct({
    timeZone: Schema.String,
    events: Schema.Array(EventEntry),
    truncated: Schema.Boolean,
  }),
  failure: CalendarError,
})
  .annotate(Tool.Title, "List events")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SearchEventsTool = Tool.make("calendar_search_events", {
  description:
    "Search every calendar (shown or hidden) by title, location or description. A recurring series appears once, as its next occurrence (or its last one if it ended). Upcoming results come first.",
  parameters: Schema.Struct({
    query: Schema.String,
    limit: Schema.optional(Schema.Number),
    timeZone: ViewerTimeZone,
  }),
  success: Schema.Struct({ timeZone: Schema.String, events: Schema.Array(EventEntry) }),
  failure: CalendarError,
})
  .annotate(Tool.Title, "Search events")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const GetEventTool = Tool.make("calendar_get_event", {
  description:
    "Read one event or occurrence in full: description, guests and their answers, video call link, and how it repeats.",
  parameters: Schema.Struct({
    calendarId: CalendarId,
    eventId: CalendarEventId,
    timeZone: ViewerTimeZone,
  }),
  success: EventDetail,
  failure: CalendarError,
})
  .annotate(Tool.Title, "Read event")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const EventWriteFields = {
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  attendees: Schema.optional(Schema.Array(Schema.String)),
  recurrence: Schema.optional(Schema.Array(Schema.String)),
  addConference: Schema.optional(Schema.Boolean),
  free: Schema.optional(Schema.Boolean),
  sendUpdates: Schema.optional(CalendarSendUpdates),
};

const CreateEventTool = Tool.make("calendar_create_event", {
  description: `Create an event. For all-day events set allDay and pass dates (YYYY-MM-DD, end exclusive; end defaults to the next day). Without end, a timed event lasts the user's default length. attendees are guest emails; recurrence takes RRULE lines like "RRULE:FREQ=WEEKLY;BYDAY=MO"; addConference adds a video call. ${TIME_NOTE}`,
  parameters: Schema.Struct({
    calendarId: CalendarId,
    start: Schema.String,
    end: Schema.optional(Schema.String),
    allDay: Schema.optional(Schema.Boolean),
    timeZone: Schema.optional(Schema.String),
    ...EventWriteFields,
  }),
  success: Schema.Struct({ event: Schema.optional(EventDetail) }),
  failure: CalendarError,
})
  .annotate(Tool.Title, "Create event")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const UpdateEventTool = Tool.make("calendar_update_event", {
  description: `Change an event: move or resize it (start/end; start alone keeps the length), change its fields, or move it to another calendar of the same account (targetCalendarId). For a recurring event, scope says which occurrences change: "this" (default), "following" (this and later ones) or "all"; ask the user when it is unclear. Omitted fields stay; attendees replaces the guest list. ${TIME_NOTE}`,
  parameters: Schema.Struct({
    calendarId: CalendarId,
    eventId: CalendarEventId,
    scope: Schema.optional(CalendarChangeScope),
    start: Schema.optional(Schema.String),
    end: Schema.optional(Schema.String),
    allDay: Schema.optional(Schema.Boolean),
    timeZone: Schema.optional(Schema.String),
    targetCalendarId: Schema.optional(CalendarId),
    ...EventWriteFields,
  }),
  success: Schema.Struct({ event: Schema.optional(EventDetail) }),
  failure: CalendarError,
})
  .annotate(Tool.Title, "Change event")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const DeleteEventTool = Tool.make("calendar_delete_event", {
  description:
    'Delete an event, or for a recurring event the occurrences scope names: "this" (default), "following" or "all". Guests are told when sendUpdates is "all". Only delete what the user asked you to delete.',
  parameters: Schema.Struct({
    calendarId: CalendarId,
    eventId: CalendarEventId,
    scope: Schema.optional(CalendarChangeScope),
    sendUpdates: Schema.optional(CalendarSendUpdates),
  }),
  success: Schema.Struct({ deleted: Schema.Boolean }),
  failure: CalendarError,
})
  .annotate(Tool.Title, "Delete event")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, false);

const RespondTool = Tool.make("calendar_respond_to_invitation", {
  description:
    'Answer an invitation: accepted, declined or tentative. scope "this" (default) answers one occurrence of a recurring event, "all" the whole series.',
  parameters: Schema.Struct({
    calendarId: CalendarId,
    eventId: CalendarEventId,
    response: Schema.Literals(["accepted", "declined", "tentative"]),
    scope: Schema.optional(Schema.Literals(["this", "all"])),
  }),
  success: Schema.Struct({ event: Schema.optional(EventDetail) }),
  failure: CalendarError,
})
  .annotate(Tool.Title, "Answer invitation")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const FindFreeTimeTool = Tool.make("calendar_find_free_time", {
  description: `Find free time of at least durationMinutes between start and end (at most two months), merging busy time across all accounts' shown calendars, or only calendarIds / accountIds. All-day events, events marked free and declined invitations don't count as busy. workingHoursOnly (default true) keeps slots inside the user's working hours. ${TIME_NOTE}`,
  parameters: Schema.Struct({
    start: Schema.String,
    end: Schema.String,
    durationMinutes: Schema.Number,
    calendarIds: Schema.optional(Schema.Array(CalendarId)),
    accountIds: Schema.optional(Schema.Array(Schema.String)),
    workingHoursOnly: Schema.optional(Schema.Boolean),
    timeZone: ViewerTimeZone,
  }),
  success: Schema.Struct({
    timeZone: Schema.String,
    slots: Schema.Array(
      Schema.Struct({ start: Schema.String, end: Schema.String, minutes: Schema.Number }),
    ),
  }),
  failure: CalendarError,
})
  .annotate(Tool.Title, "Find free time")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CalendarToolkit = Toolkit.make(
  ListAccountsTool,
  ListEventsTool,
  SearchEventsTool,
  GetEventTool,
  CreateEventTool,
  UpdateEventTool,
  DeleteEventTool,
  RespondTool,
  FindFreeTimeTool,
);
