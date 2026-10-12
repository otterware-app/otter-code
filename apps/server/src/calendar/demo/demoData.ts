// @effect-diagnostics globalDate:off - Formats fixed epoch values as Google's RFC 3339 stamps.
/**
 * Demo calendars that look like Google's: accounts, calendar lists and events generated
 * deterministically from `(profile, seed)` around an anchor Monday, in Google Calendar API
 * shapes, so demo accounts run through exactly the sync, materialization and edit paths of a
 * real account.
 *
 * - `standard`: three accounts (work, personal, a side project) with half a year of realistic
 *   data on either side of the anchor: recurring meetings with exceptions, invitations in every
 *   response state, video calls, all-day and multi-day events, events in other zones, holidays.
 * - `massive`: ten accounts with four calendars each and five years of dense workdays, for
 *   performance work. Days are generated on demand, so a page of `events.list` costs only the
 *   days it covers.
 *
 * @module demoData
 */
import {
  DAY_MS,
  civilDate,
  dayNumber,
  formatZonedIso,
  fromZoned,
  weekday,
  type DayNumber,
} from "@t3tools/shared/calendar/time";
import { occurrenceId, recurrenceEnd } from "@t3tools/shared/calendar/recurrence";

import { eventTimes } from "../eventModel.ts";
import { recurrenceSeriesOf } from "../materialize.ts";
import type { RemoteAttendee, RemoteCalendar, RemoteEvent } from "../providers/CalendarProvider.ts";

export type DemoProfile = "standard" | "massive";

export const DEFAULT_DEMO_SEED = 1;

type CalendarKind =
  | "work-primary"
  | "work-team"
  | "work-launches"
  | "holidays"
  | "personal-primary"
  | "family"
  | "fitness"
  | "birthdays"
  | "side-primary"
  | "side-team"
  | "massive-primary"
  | "massive-team"
  | "massive-projects"
  | "massive-personal";

export interface DemoCalendarSpec {
  readonly remote: RemoteCalendar & { readonly id: string };
  readonly kind: CalendarKind;
}

export interface DemoAccountSpec {
  readonly index: number;
  readonly email: string;
  readonly displayName: string;
  readonly timeZone: string;
  readonly calendars: ReadonlyArray<DemoCalendarSpec>;
}

// ── Deterministic randomness ─────────────────────────────────────────

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: small, fast and good enough for demo data. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Rng = () => number;

const int = (rng: Rng, min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const pick = <A>(rng: Rng, items: ReadonlyArray<A>): A => items[Math.floor(rng() * items.length)]!;
const chance = (rng: Rng, probability: number) => rng() < probability;

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

/** A Google-style event id (base32hex), stable for the same parts. */
function stableId(...parts: ReadonlyArray<string | number>): string {
  const rng = makeRng(hashString(parts.join("|")));
  let id = "";
  for (let index = 0; index < 22; index += 1) id += BASE32HEX[Math.floor(rng() * 32)];
  return id;
}

function meetCode(rng: Rng): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const run = (length: number) =>
    Array.from({ length }, () => letters[Math.floor(rng() * 26)]).join("");
  return `${run(3)}-${run(4)}-${run(3)}`;
}

/** A Google Meet conference like Google creates it. */
export function meetConference(code: string): Pick<RemoteEvent, "conferenceData" | "hangoutLink"> {
  const uri = `https://meet.google.com/${code}`;
  return {
    hangoutLink: uri,
    conferenceData: {
      conferenceId: code,
      conferenceSolution: { name: "Google Meet", key: { type: "hangoutsMeet" } },
      entryPoints: [
        { entryPointType: "video", uri, label: `meet.google.com/${code}` },
        {
          entryPointType: "more",
          uri: `https://tel.meet/${code}?pin=${hashString(code) % 10_000_000_000}`,
        },
      ],
    },
  };
}

export function randomMeetCode(random: () => number): string {
  return meetCode(random);
}

// ── People ───────────────────────────────────────────────────────────

interface Person {
  readonly email: string;
  readonly displayName: string;
}

const person = (displayName: string, domain: string): Person => ({
  displayName,
  email: `${displayName.toLowerCase().replace(/[^a-z]+/g, ".")}@${domain}`,
});

const NORTHWIND = {
  jordan: person("Jordan Lee", "northwind.example"),
  priya: person("Priya Shah", "northwind.example"),
  sam: person("Sam Carter", "northwind.example"),
  mia: person("Mia Chen", "northwind.example"),
  lukas: person("Lukas Weber", "northwind.example"),
  elena: person("Elena Rossi", "northwind.example"),
  hannah: person("Hannah Becker", "northwind.example"),
  kenji: person("Kenji Tanaka", "northwind.example"),
};
const TEAM = [NORTHWIND.priya, NORTHWIND.sam, NORTHWIND.mia, NORTHWIND.lukas];
const CUSTOMERS = [
  { company: "Acme", contact: person("Dana Brooks", "acme.example") },
  { company: "Globex", contact: person("Hank Scorpio", "globex.example") },
  { company: "Initech", contact: person("Bill Lumbergh", "initech.example") },
  { company: "Umbrella", contact: person("Alice Abernathy", "umbrella.example") },
  { company: "Hooli", contact: person("Gavin Belson", "hooli.example") },
];
const FEATURES = ["onboarding", "billing page", "search", "mobile nav", "settings", "reports"];
const ROOMS = ["Room Fjord (3rd floor)", "Room Delta", "Room Atlas", "Lounge", "Room Kiez"];
const FRIENDS = ["Sam", "Lea", "Tom", "Nina", "Jonas", "Clara", "Ben", "Mara"];
const OTTERWARE_NOOR = person("Noor Haddad", "otterware.example");

// ── Event builders ───────────────────────────────────────────────────

interface Context {
  readonly seed: number;
  readonly account: DemoAccountSpec;
  readonly calendar: DemoCalendarSpec;
  /** RFC 3339 stamp for `created`/`updated`. */
  readonly stamp: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Google answers with the offset of the event's zone, e.g. `2026-10-01T09:30:00+02:00`. */
const formatLocal = (ms: number, zone: string) => formatZonedIso(ms, zone);

function selfOrganizer(context: Context): Pick<RemoteEvent, "organizer" | "creator"> {
  const { account, calendar } = context;
  return {
    organizer: calendar.remote.primary
      ? { email: account.email, displayName: account.displayName, self: true }
      : { email: calendar.remote.id, displayName: calendar.remote.summary ?? "", self: true },
    creator: { email: account.email, displayName: account.displayName, self: true },
  };
}

function base(context: Context, id: string, summary: string): RemoteEvent {
  return {
    id,
    status: "confirmed",
    summary,
    iCalUID: `${id}@google.com`,
    sequence: 0,
    created: context.stamp,
    updated: context.stamp,
    etag: `"${hashString(id)}"`,
    eventType: "default",
    ...selfOrganizer(context),
  };
}

interface TimedOptions {
  readonly zone?: string;
  /** A different zone for the end (flights). */
  readonly endZone?: string;
  readonly extra?: Partial<RemoteEvent>;
}

function timed(
  context: Context,
  id: string,
  summary: string,
  day: DayNumber,
  startMinutes: number,
  durationMinutes: number,
  options: TimedOptions = {},
): RemoteEvent {
  const zone = options.zone ?? context.account.timeZone;
  const start = fromZoned(day, startMinutes, zone);
  const end = start + durationMinutes * 60_000;
  return {
    ...base(context, id, summary),
    start: { dateTime: formatLocal(start, zone), timeZone: zone },
    end: { dateTime: formatLocal(end, zone), timeZone: options.endZone ?? zone },
    ...options.extra,
  };
}

function allDay(
  context: Context,
  id: string,
  summary: string,
  day: DayNumber,
  days: number,
  extra: Partial<RemoteEvent> = {},
): RemoteEvent {
  return {
    ...base(context, id, summary),
    start: { date: formatDate(day) },
    end: { date: formatDate(day + days) },
    transparency: "transparent",
    ...extra,
  };
}

function formatDate(day: DayNumber): string {
  const { year, month, day: dom } = civilDate(day);
  return `${year}-${String(month).padStart(2, "0")}-${String(dom).padStart(2, "0")}`;
}

/** An exception of `master` replacing the occurrence that starts at `originalStart`. */
function exception(
  master: RemoteEvent,
  originalStart: number,
  change: "cancelled" | Partial<RemoteEvent>,
): RemoteEvent {
  const allDayMaster = master.start?.date !== undefined;
  const id = occurrenceId(master.id, originalStart, allDayMaster);
  const zone = master.start?.timeZone ?? "UTC";
  const originalStartTime = allDayMaster
    ? { date: formatDate(Math.floor(originalStart / DAY_MS)) }
    : { dateTime: formatLocal(originalStart, zone), timeZone: zone };
  if (change === "cancelled") {
    return { id, status: "cancelled", recurringEventId: master.id, originalStartTime };
  }
  const { recurrence: _recurrence, ...rest } = master;
  return { ...rest, id, recurringEventId: master.id, originalStartTime, ...change };
}

function hosting(context: Context, guests: ReadonlyArray<Person>, rng: Rng): Partial<RemoteEvent> {
  return {
    attendees: [
      {
        email: context.account.email,
        displayName: context.account.displayName,
        self: true,
        organizer: true,
        responseStatus: "accepted",
      },
      ...guests.map((guest): RemoteAttendee => ({
        ...guest,
        responseStatus: pick(rng, ["accepted", "accepted", "accepted", "tentative", "needsAction"]),
      })),
    ],
  };
}

function invitedBy(
  context: Context,
  organizer: Person,
  others: ReadonlyArray<Person>,
  response: NonNullable<RemoteAttendee["responseStatus"]>,
  extra: Partial<RemoteEvent> = {},
): Partial<RemoteEvent> {
  return {
    organizer: { ...organizer, self: false },
    creator: { ...organizer },
    attendees: [
      { ...organizer, organizer: true, responseStatus: "accepted" },
      {
        email: context.account.email,
        displayName: context.account.displayName,
        self: true,
        responseStatus: response,
      },
      ...others.map((other): RemoteAttendee => ({ ...other, responseStatus: "accepted" })),
    ],
    ...extra,
  };
}

const meet = (rng: Rng) => meetConference(meetCode(rng));

/** New times for an exception: `minutes` after local midnight of `day`. */
function movedTo(
  context: Context,
  day: DayNumber,
  minutes: number,
  duration: number,
): Pick<RemoteEvent, "start" | "end"> {
  const zone = context.account.timeZone;
  const start = fromZoned(day, minutes, zone);
  return {
    start: { dateTime: formatLocal(start, zone), timeZone: zone },
    end: { dateTime: formatLocal(start + duration * 60_000, zone), timeZone: zone },
  };
}
const WEEKDAYS_RULE = "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";

// ── What a calendar holds ────────────────────────────────────────────

/** A calendar's events: fixed ones (series, holidays) plus days generated on demand. */
export interface DemoCalendarSource {
  readonly fixed: ReadonlyArray<RemoteEvent>;
  readonly from: DayNumber;
  readonly to: DayNumber;
  readonly day: (day: DayNumber) => ReadonlyArray<RemoteEvent>;
}

const noDays = () => [];

export function demoCalendarSource(
  profile: DemoProfile,
  seed: number,
  account: DemoAccountSpec,
  calendar: DemoCalendarSpec,
  anchor: DayNumber,
): DemoCalendarSource {
  const context: Context = {
    seed,
    account,
    calendar,
    stamp: iso((anchor - 120) * DAY_MS + 9 * 3_600_000),
  };
  if (profile === "massive") return massiveCalendar(context, anchor);
  const from = anchor - 26 * 7;
  const to = anchor + 26 * 7;
  const rng = makeRng(hashString(`${seed}|${account.index}|${calendar.kind}`));
  const fixed = STANDARD_BUILDERS[calendar.kind]?.(context, anchor, rng) ?? [];
  return { fixed, from, to, day: noDays };
}

type Builder = (context: Context, anchor: DayNumber, rng: Rng) => Array<RemoteEvent>;

const id = (context: Context, key: string | number) =>
  stableId(context.seed, context.account.index, context.calendar.kind, key);

const STANDARD_BUILDERS: Partial<Record<CalendarKind, Builder>> = {
  "work-primary": (context, anchor, rng) => {
    const events: Array<RemoteEvent> = [];
    const standup = timed(
      context,
      id(context, "standup"),
      "Daily standup",
      anchor - 30 * 7,
      570,
      15,
      {
        extra: {
          recurrence: [WEEKDAYS_RULE],
          location: "Room Fjord (3rd floor)",
          ...hosting(context, TEAM, rng),
          ...meet(rng),
        },
      },
    );
    const standupAt = (day: DayNumber) => fromZoned(day, 570, context.account.timeZone);
    events.push(
      standup,
      exception(standup, standupAt(anchor + 2), {
        summary: "Daily standup (moved)",
        ...movedTo(context, anchor + 2, 615, 15),
      }),
      exception(standup, standupAt(anchor + 11), "cancelled"),
      exception(standup, standupAt(anchor - 7), "cancelled"),
    );

    events.push(
      timed(context, id(context, "one-on-one"), "1:1 Jordan / Alex", anchor - 40 * 7 + 1, 840, 30, {
        extra: {
          recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
          description: "Running notes: https://docs.northwind.example/1-1-jordan-alex",
          ...invitedBy(context, NORTHWIND.jordan, [], "accepted"),
          ...meet(rng),
        },
      }),
      timed(context, id(context, "planning"), "Sprint planning", anchor - 20 * 7, 600, 90, {
        extra: {
          recurrence: ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"],
          location: "Room Atlas",
          description: "Bring your estimates. Board: https://linear.example/northwind/sprints",
          ...hosting(context, TEAM, rng),
          ...meet(rng),
        },
      }),
      timed(
        context,
        id(context, "all-hands"),
        "Northwind all-hands",
        anchor - 30 * 7 + 1,
        960,
        60,
        {
          extra: {
            recurrence: ["RRULE:FREQ=MONTHLY;BYDAY=1TU"],
            location: "Northwind HQ, Torstraße 1, 10119 Berlin",
            ...invitedBy(context, NORTHWIND.hannah, TEAM, "accepted"),
            ...meet(rng),
          },
        },
      ),
      timed(context, id(context, "lunch"), "Lunch", anchor - 30 * 7, 750, 60, {
        extra: { recurrence: [WEEKDAYS_RULE], transparency: "transparent", colorId: "2" },
      }),
      timed(context, id(context, "focus"), "Focus time", anchor - 10 * 7 + 3, 810, 150, {
        extra: { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"], colorId: "5" },
      }),
      timed(context, id(context, "tokyo"), "Tokyo team sync", anchor - 16 * 7 + 2, 1020, 45, {
        zone: "Asia/Tokyo",
        extra: {
          recurrence: ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE"],
          ...invitedBy(context, NORTHWIND.kenji, [NORTHWIND.mia], "accepted"),
          ...meet(rng),
        },
      }),
      timed(context, id(context, "metrics"), "Weekly metrics review", anchor - 4 * 7 + 4, 660, 30, {
        extra: {
          recurrence: ["RRULE:FREQ=WEEKLY;COUNT=12"],
          ...hosting(context, [NORTHWIND.elena], rng),
        },
      }),
    );

    for (let week = -26; week < 26; week += 1) {
      const monday = anchor + week * 7;
      const calls = int(rng, 2, 4);
      for (let call = 0; call < calls; call += 1) {
        const customer = pick(rng, CUSTOMERS);
        events.push(
          timed(
            context,
            id(context, `call-${week}-${call}`),
            `Customer call: ${customer.company}`,
            monday + int(rng, 0, 4),
            600 + int(rng, 0, 12) * 30,
            pick(rng, [30, 45, 60]),
            { extra: { ...hosting(context, [customer.contact], rng), ...meet(rng) } },
          ),
        );
      }
      const reviews = int(rng, 1, 2);
      for (let review = 0; review < reviews; review += 1) {
        const response =
          week < 0
            ? "accepted"
            : pick(rng, ["accepted", "accepted", "needsAction", "declined", "tentative"] as const);
        events.push(
          timed(
            context,
            id(context, `review-${week}-${review}`),
            `Design review: ${pick(rng, FEATURES)}`,
            monday + int(rng, 0, 4),
            660 + int(rng, 0, 10) * 30,
            60,
            {
              extra: {
                location: pick(rng, ROOMS),
                ...invitedBy(context, NORTHWIND.mia, [NORTHWIND.priya], response),
                ...meet(rng),
              },
            },
          ),
        );
      }
      if (((week % 3) + 3) % 3 === 0) {
        events.push(
          timed(
            context,
            id(context, `acme-${week}`),
            "Call with Acme (New York)",
            monday + 3,
            660,
            45,
            {
              zone: "America/New_York",
              extra: {
                ...invitedBy(context, CUSTOMERS[0]!.contact, [], "accepted"),
                ...meet(rng),
              },
            },
          ),
        );
      }
      if (((week % 4) + 4) % 4 === 0) {
        // Stacks on sprint planning (10:00–11:30) four deep.
        events.push(
          timed(context, id(context, `roadmap-${week}`), "Roadmap sync", monday, 600, 60, {
            extra: invitedBy(context, NORTHWIND.jordan, [NORTHWIND.elena], "accepted"),
          }),
          timed(context, id(context, `debrief-${week}`), "Hiring debrief", monday, 630, 60, {
            extra: { ...hosting(context, [NORTHWIND.lukas, NORTHWIND.elena], rng) },
          }),
          timed(context, id(context, `checkin-${week}`), "Quick check-in", monday, 645, 30, {
            extra: { ...hosting(context, [NORTHWIND.sam], rng) },
          }),
        );
      }
    }

    events.push(
      timed(context, id(context, "qbr"), "Quarterly business review", anchor + 7 + 3, 840, 120, {
        extra: {
          location: "Northwind HQ, Board room",
          description: "Agenda:\n1. Revenue\n2. Hiring\n3. Roadmap",
          ...invitedBy(
            context,
            NORTHWIND.hannah,
            [NORTHWIND.jordan, NORTHWIND.elena],
            "needsAction",
          ),
          ...meet(rng),
        },
      }),
      timed(context, id(context, "vendor"), "Vendor demo: Globex", anchor + 2, 900, 45, {
        extra: invitedBy(context, CUSTOMERS[1]!.contact, [], "declined"),
      }),
      timed(
        context,
        id(context, "offsite-planning"),
        "Offsite planning",
        anchor + 14 + 1,
        780,
        60,
        {
          extra: invitedBy(context, NORTHWIND.priya, TEAM, "tentative"),
        },
      ),
      timed(
        context,
        id(context, "summit"),
        "Web Summit Lisbon",
        anchor + 28 + 1,
        540,
        2 * 1440 + 540,
        {
          zone: "Europe/Lisbon",
          extra: { location: "Altice Arena, Lisbon", colorId: "3" },
        },
      ),
      timed(context, id(context, "interview"), "Interview: backend engineer", anchor + 3, 870, 60, {
        extra: {
          status: "tentative",
          ...hosting(context, [NORTHWIND.lukas], rng),
          ...meet(rng),
        },
      }),
    );
    return events;
  },

  "work-team": (context, anchor, rng) => {
    const events: Array<RemoteEvent> = [
      timed(context, id(context, "retro"), "Retro", anchor - 20 * 7 + 4, 900, 60, {
        extra: { recurrence: ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR"], ...meet(rng) },
      }),
      timed(context, id(context, "team-lunch"), "Team lunch", anchor - 26 * 7 + 4, 720, 90, {
        extra: { recurrence: ["RRULE:FREQ=MONTHLY;BYDAY=-1FR"], location: "Markthalle Neun" },
      }),
      allDay(context, id(context, "offsite"), "Team offsite", anchor + 6 * 7, 3, {
        location: "Landgut Stober, Nauen",
        transparency: "opaque",
      }),
      allDay(context, id(context, "leave"), "Parental leave: Lukas", anchor + 2 * 7, 21),
    ];
    for (let week = -26; week < 26; week += 1) {
      const monday = anchor + week * 7;
      events.push(
        allDay(
          context,
          id(context, `oncall-${week}`),
          `On call: ${pick(rng, TEAM).displayName}`,
          monday,
          7,
        ),
      );
      if (((week % 6) + 6) % 6 === 0) {
        events.push(
          allDay(context, id(context, `freeze-${week}`), "Release freeze", monday + 2, 3),
        );
      }
    }
    return events;
  },

  "work-launches": (context, anchor) => {
    const events: Array<RemoteEvent> = [];
    for (let step = -8; step < 9; step += 1) {
      const day = anchor + step * 21 + 3;
      const version = `v3.${step + 9}`;
      events.push(
        allDay(context, id(context, `launch-${step}`), `Launch: Northwind ${version}`, day, 1, {
          colorId: "3",
        }),
        timed(
          context,
          id(context, `readiness-${step}`),
          `Launch readiness: ${version}`,
          day - 1,
          960,
          30,
        ),
      );
    }
    return events;
  },

  holidays: (context, anchor) => {
    const events: Array<RemoteEvent> = [];
    const firstYear = civilDate(anchor - 26 * 7).year;
    const lastYear = civilDate(anchor + 26 * 7).year;
    for (let year = firstYear; year <= lastYear; year += 1) {
      const easter = easterSunday(year);
      const holidays: ReadonlyArray<readonly [string, DayNumber]> = [
        ["New Year's Day", dayNumber(year, 1, 1)],
        ["Good Friday", easter - 2],
        ["Easter Monday", easter + 1],
        ["Labour Day", dayNumber(year, 5, 1)],
        ["Ascension Day", easter + 39],
        ["Whit Monday", easter + 50],
        ["Day of German Unity", dayNumber(year, 10, 3)],
        ["Christmas Eve", dayNumber(year, 12, 24)],
        ["Christmas Day", dayNumber(year, 12, 25)],
        ["Boxing Day", dayNumber(year, 12, 26)],
        ["New Year's Eve", dayNumber(year, 12, 31)],
      ];
      for (const [name, day] of holidays) {
        events.push(
          allDay(context, id(context, `${year}-${name}`), name, day, 1, {
            description: "Public holiday",
            organizer: { email: context.calendar.remote.id, displayName: "Holidays in Germany" },
          }),
        );
      }
    }
    return events;
  },

  "personal-primary": (context, anchor, rng) => {
    const events: Array<RemoteEvent> = [
      timed(context, id(context, "mom-call"), "Call Mom", anchor - 26 * 7 + 6, 1080, 30, {
        extra: { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=SU"] },
      }),
      timed(context, id(context, "dentist"), "Dentist", anchor + 14 + 2, 480, 45, {
        extra: { location: "Zahnarztpraxis Mitte, Rosenthaler Str. 40, Berlin" },
      }),
      allDay(context, id(context, "lisbon"), "Trip to Lisbon", anchor + 8 * 7 + 4, 4, {
        location: "Lisbon, Portugal",
        colorId: "6",
      }),
      timed(context, id(context, "flight-out"), "Flight BER → LIS", anchor + 8 * 7 + 4, 430, 255, {
        endZone: "Europe/Lisbon",
        extra: { location: "Berlin Brandenburg Airport (BER)", description: "TP 537, seat 14A" },
      }),
      timed(
        context,
        id(context, "flight-back"),
        "Flight LIS → BER",
        anchor + 8 * 7 + 7,
        1080,
        210,
        {
          zone: "Europe/Lisbon",
          endZone: "Europe/Berlin",
          extra: { location: "Lisbon Airport (LIS)" },
        },
      ),
    ];
    for (let week = -26; week < 26; week += 1) {
      const friday = anchor + week * 7 + 4;
      if (chance(rng, 0.45)) {
        const [a, b] = [pick(rng, FRIENDS), pick(rng, FRIENDS)];
        events.push(
          timed(
            context,
            id(context, `dinner-${week}`),
            `Dinner with ${a} & ${b}`,
            friday + int(rng, 0, 1),
            1170,
            150,
            {
              extra: {
                location: pick(rng, [
                  "Mrs Robinson's",
                  "Lode & Stijn",
                  "Cookies Cream",
                  "Katz Orange",
                ]),
              },
            },
          ),
        );
      }
      if (week % 5 === 0) {
        events.push(timed(context, id(context, `haircut-${week}`), "Haircut", friday + 1, 600, 45));
      }
    }
    return events;
  },

  family: (context, anchor) => [
    timed(context, id(context, "swim"), "Kids' swim lessons", anchor - 26 * 7 + 5, 600, 60, {
      extra: { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=SA"], location: "Stadtbad Neukölln" },
    }),
    timed(
      context,
      id(context, "mom-birthday"),
      "Mom's birthday dinner",
      anchor + 3 * 7 + 5,
      1110,
      180,
      {
        extra: { location: "Restaurant Tim Raue" },
      },
    ),
    timed(
      context,
      id(context, "parents-evening"),
      "Parents' evening",
      anchor + 5 * 7 + 2,
      1110,
      90,
    ),
    allDay(context, id(context, "grandma"), "Grandma visiting", anchor + 10 * 7 + 2, 5),
    allDay(context, id(context, "school-break"), "Autumn school break", anchor - 7, 12),
  ],

  fitness: (context, anchor) => {
    const gym = timed(context, id(context, "gym"), "Gym", anchor - 26 * 7, 420, 60, {
      extra: {
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"],
        location: "Urban Sports Club, Mitte",
      },
    });
    const gymAt = (day: DayNumber) => fromZoned(day, 420, context.account.timeZone);
    return [
      gym,
      exception(gym, gymAt(anchor + 2), "cancelled"),
      exception(gym, gymAt(anchor + 7 + 4), {
        ...movedTo(context, anchor + 7 + 4, 1080, 60),
      }),
      timed(context, id(context, "run"), "Long run", anchor - 26 * 7 + 6, 480, 90, {
        extra: { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=SU"], location: "Tempelhofer Feld" },
      }),
      timed(context, id(context, "yoga"), "Yoga", anchor - 2 * 7 + 3, 1140, 75, {
        extra: { recurrence: ["RRULE:FREQ=WEEKLY;COUNT=10"] },
      }),
    ];
  },

  birthdays: (context, anchor, rng) =>
    FRIENDS.map((friend, index) => {
      const year = civilDate(anchor).year - 3;
      const day = dayNumber(year, int(rng, 1, 12), int(rng, 1, 28));
      return allDay(context, id(context, `birthday-${index}`), `${friend}'s birthday`, day, 1, {
        recurrence: ["RRULE:FREQ=YEARLY"],
        ...(index % 2 === 0 ? { colorId: "1" } : {}),
      });
    }),

  "side-primary": (context, anchor, rng) => {
    const events: Array<RemoteEvent> = [
      timed(context, id(context, "weekly"), "Otterware weekly", anchor - 26 * 7 + 3, 1140, 60, {
        extra: {
          recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"],
          ...hosting(context, [OTTERWARE_NOOR], rng),
          ...meet(rng),
        },
      }),
      timed(context, id(context, "investor"), "Investor update call", anchor + 9 + 1, 1110, 30, {
        extra: { ...hosting(context, [person("Rita Novak", "fund.example")], rng), ...meet(rng) },
      }),
    ];
    for (let week = -26; week < 26; week += 1) {
      if (chance(rng, 0.6)) {
        events.push(
          timed(
            context,
            id(context, `pairing-${week}`),
            "Pairing session with Noor",
            anchor + week * 7 + 5,
            570,
            120,
            {
              extra: { ...hosting(context, [OTTERWARE_NOOR], rng), ...meet(rng) },
            },
          ),
        );
      }
    }
    return events;
  },

  "side-team": (context, anchor, rng) => [
    timed(context, id(context, "design"), "Design review", anchor - 20 * 7 + 1, 1110, 45, {
      extra: {
        recurrence: ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU"],
        ...invitedBy(context, OTTERWARE_NOOR, [], "accepted", { guestsCanModify: true }),
        ...meet(rng),
      },
    }),
    allDay(context, id(context, "launch"), "Otterware v1.0 launch", anchor + 5 * 7 + 3, 1, {
      colorId: "11",
    }),
    timed(context, id(context, "party"), "Release party 🎉", anchor + 5 * 7 + 4, 1140, 240, {
      extra: { location: "Holzmarkt 25, Berlin" },
    }),
  ],
};

/** Easter Sunday (Gregorian), for the holiday calendar. */
function easterSunday(year: number): DayNumber {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return dayNumber(year, month, day);
}

// ── Massive ──────────────────────────────────────────────────────────

const MASSIVE_PEOPLE = [
  ["Avery Stone", "northwind.example", "Europe/Berlin"],
  ["Blake Rivera", "contoso.example", "America/New_York"],
  ["Casey Morgan", "globex.example", "Europe/London"],
  ["Devon Park", "initech.example", "Asia/Tokyo"],
  ["Emery Walsh", "umbrella.example", "America/Los_Angeles"],
  ["Finley Brooks", "hooli.example", "Europe/Paris"],
  ["Gray Holloway", "stark.example", "Australia/Sydney"],
  ["Harper Quinn", "wayne.example", "Asia/Kolkata"],
  ["Indy Novak", "acme.example", "America/Chicago"],
  ["Jules Laurent", "tyrell.example", "Europe/Madrid"],
] as const;

const MASSIVE_TITLES = [
  "Sync",
  "Customer call",
  "Design review",
  "Interview",
  "1:1",
  "Pipeline review",
  "Architecture discussion",
  "Budget check",
  "Demo prep",
  "Hiring panel",
  "Incident review",
  "Roadmap",
  "Vendor call",
  "Workshop",
  "Office hours",
];
const MASSIVE_TOPICS = [
  "Atlas",
  "Borealis",
  "Cobalt",
  "Delta",
  "Ember",
  "Falcon",
  "Granite",
  "Helix",
];

function massiveCalendar(context: Context, anchor: DayNumber): DemoCalendarSource {
  const from = anchor - 3 * 52 * 7;
  const to = anchor + 2 * 52 * 7;
  const kind = context.calendar.kind;
  const rng = makeRng(hashString(`${context.seed}|${context.account.index}|${kind}|series`));
  const fixed: Array<RemoteEvent> = [];
  const series = (
    key: string,
    summary: string,
    first: DayNumber,
    minutes: number,
    duration: number,
    rule: string,
    extra: Partial<RemoteEvent> = {},
  ) =>
    fixed.push(
      timed(context, id(context, key), summary, first, minutes, duration, {
        extra: { recurrence: [rule], ...extra },
      }),
    );
  const colleagues = MASSIVE_PEOPLE.filter((_, index) => index !== context.account.index).map(
    ([name, domain]) => person(name, domain),
  );
  const firstMonday = from - weekday(from) + 1;
  switch (kind) {
    case "massive-primary":
      series("standup", "Standup", firstMonday, 555, 15, WEEKDAYS_RULE, meet(rng));
      series(
        "one-on-one",
        "1:1 with manager",
        firstMonday + 1,
        840,
        30,
        "RRULE:FREQ=WEEKLY;BYDAY=TU",
        invitedBy(context, colleagues[0]!, [], "accepted"),
      );
      series(
        "planning",
        "Planning",
        firstMonday,
        600,
        60,
        "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
        hosting(context, colleagues.slice(1, 4), rng),
      );
      series(
        "all-hands",
        "All-hands",
        firstMonday + 1,
        960,
        60,
        "RRULE:FREQ=MONTHLY;BYDAY=1TU",
        invitedBy(context, colleagues[1]!, [], "accepted"),
      );
      break;
    case "massive-team":
      series("retro", "Retro", firstMonday + 4, 900, 60, "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR");
      series("team-sync-a", "Team sync", firstMonday + 1, 660, 30, "RRULE:FREQ=WEEKLY;BYDAY=TU");
      series("team-sync-b", "Team sync", firstMonday + 3, 660, 30, "RRULE:FREQ=WEEKLY;BYDAY=TH");
      break;
    case "massive-projects":
      for (let index = 0; index < 3; index += 1) {
        series(
          `project-${index}`,
          `Project ${MASSIVE_TOPICS[index]} sync`,
          firstMonday + index + 1,
          780 + index * 60,
          45,
          `RRULE:FREQ=WEEKLY;BYDAY=${["TU", "WE", "TH"][index]}`,
        );
      }
      break;
    case "massive-personal":
      series("gym", "Gym", firstMonday, 420, 60, "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR", {
        transparency: "opaque",
      });
      series("yoga", "Yoga", firstMonday + 3, 1140, 60, "RRULE:FREQ=WEEKLY;BYDAY=TH");
      series("parents", "Call parents", firstMonday + 6, 1080, 30, "RRULE:FREQ=WEEKLY;BYDAY=SU");
      for (let index = 0; index < 10; index += 1) {
        fixed.push(
          allDay(
            context,
            id(context, `birthday-${index}`),
            `${FRIENDS[index % FRIENDS.length]} ${index}'s birthday`,
            from + int(rng, 0, 364),
            1,
            {
              recurrence: ["RRULE:FREQ=YEARLY"],
            },
          ),
        );
      }
      break;
    default:
      break;
  }

  const day = (current: DayNumber): ReadonlyArray<RemoteEvent> => {
    const dayRng = makeRng(
      hashString(`${context.seed}|${context.account.index}|${kind}|${current}`),
    );
    const workday = weekday(current) >= 1 && weekday(current) <= 5;
    const count =
      kind === "massive-primary"
        ? workday
          ? int(dayRng, 5, 8)
          : 0
        : kind === "massive-team"
          ? workday
            ? int(dayRng, 3, 5)
            : 0
          : kind === "massive-projects"
            ? workday
              ? int(dayRng, 1, 2)
              : 0
            : workday
              ? int(dayRng, 0, 1)
              : int(dayRng, 1, 2);
    const events: Array<RemoteEvent> = [];
    for (let index = 0; index < count; index += 1) {
      const personal = kind === "massive-personal";
      const start = personal
        ? workday
          ? 1110
          : 600 + int(dayRng, 0, 16) * 30
        : 480 + int(dayRng, 0, 18) * 30;
      const duration = pick(dayRng, [15, 30, 30, 45, 60, 60, 90]);
      const title = personal
        ? pick(dayRng, ["Dinner", "Groceries", "Cinema", "Climbing", "Brunch", "Museum"])
        : `${pick(dayRng, MASSIVE_TITLES)}: ${pick(dayRng, MASSIVE_TOPICS)}`;
      const roll = dayRng();
      const extra: Partial<RemoteEvent> =
        personal || roll < 0.5
          ? {}
          : roll < 0.8
            ? { ...hosting(context, [pick(dayRng, colleagues)], dayRng), ...meet(dayRng) }
            : invitedBy(
                context,
                pick(dayRng, colleagues),
                [],
                pick(dayRng, ["accepted", "needsAction", "declined", "tentative"] as const),
              );
      events.push(
        timed(context, id(context, `${current}-${index}`), title, current, start, duration, {
          extra: { ...extra, ...(roll > 0.9 ? { location: pick(dayRng, ROOMS) } : {}) },
        }),
      );
    }
    if (
      kind === "massive-team" &&
      weekday(current) === 1 &&
      ((current - firstMonday) / 7) % 8 === 0
    ) {
      events.push(
        allDay(context, id(context, `offsite-${current}`), "Team offsite", current + 2, 2),
      );
    }
    return events;
  };
  return { fixed, from, to, day };
}

// ── Accounts ─────────────────────────────────────────────────────────

const holidayCalendarId = "en.german#holiday@group.v.calendar.google.com";

function calendarSpec(
  kind: CalendarKind,
  id: string,
  summary: string,
  backgroundColor: string,
  accessRole: "owner" | "writer" | "reader",
  timeZone: string,
  primary = false,
): DemoCalendarSpec {
  return {
    kind,
    remote: {
      id,
      summary,
      backgroundColor,
      foregroundColor: "#000000",
      accessRole,
      primary,
      selected: true,
      timeZone,
    },
  };
}

const groupId = (seed: number, key: string) => `${stableId(seed, key)}@group.calendar.google.com`;

export function demoAccounts(profile: DemoProfile, seed: number): ReadonlyArray<DemoAccountSpec> {
  if (profile === "massive") {
    return MASSIVE_PEOPLE.map(([name, domain, zone], index) => {
      const email = `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@${domain}`;
      return {
        index,
        email,
        displayName: name,
        timeZone: zone,
        calendars: [
          calendarSpec("massive-primary", email, name, "#039be5", "owner", zone, true),
          calendarSpec(
            "massive-team",
            groupId(seed, `${index}-team`),
            "Team",
            "#33b679",
            "writer",
            zone,
          ),
          calendarSpec(
            "massive-projects",
            groupId(seed, `${index}-projects`),
            "Projects",
            "#8e24aa",
            "owner",
            zone,
          ),
          calendarSpec(
            "massive-personal",
            groupId(seed, `${index}-personal`),
            "Personal",
            "#f4511e",
            "owner",
            zone,
          ),
        ],
      };
    });
  }
  const berlin = "Europe/Berlin";
  return [
    {
      index: 0,
      email: "alex.morgan@northwind.example",
      displayName: "Alex Morgan",
      timeZone: berlin,
      calendars: [
        calendarSpec(
          "work-primary",
          "alex.morgan@northwind.example",
          "Alex Morgan",
          "#039be5",
          "owner",
          berlin,
          true,
        ),
        calendarSpec(
          "work-team",
          groupId(seed, "team-northwind"),
          "Team Northwind",
          "#33b679",
          "writer",
          berlin,
        ),
        calendarSpec(
          "work-launches",
          groupId(seed, "product-launches"),
          "Product launches",
          "#8e24aa",
          "owner",
          berlin,
        ),
        calendarSpec(
          "holidays",
          holidayCalendarId,
          "Holidays in Germany",
          "#0b8043",
          "reader",
          berlin,
        ),
      ],
    },
    {
      index: 1,
      email: "alex.m.personal@gmail.example",
      displayName: "Alex Morgan",
      timeZone: berlin,
      calendars: [
        calendarSpec(
          "personal-primary",
          "alex.m.personal@gmail.example",
          "Alex Morgan",
          "#f4511e",
          "owner",
          berlin,
          true,
        ),
        calendarSpec("family", groupId(seed, "family"), "Family", "#33b679", "owner", berlin),
        calendarSpec("fitness", groupId(seed, "fitness"), "Fitness", "#f6bf26", "owner", berlin),
        calendarSpec(
          "birthdays",
          groupId(seed, "birthdays"),
          "Birthdays",
          "#7986cb",
          "owner",
          berlin,
        ),
      ],
    },
    {
      index: 2,
      email: "alex@otterware.example",
      displayName: "Alex Morgan",
      timeZone: berlin,
      calendars: [
        calendarSpec(
          "side-primary",
          "alex@otterware.example",
          "Alex",
          "#039be5",
          "owner",
          berlin,
          true,
        ),
        calendarSpec(
          "side-team",
          groupId(seed, "otterware-team"),
          "Otterware team",
          "#8e24aa",
          "writer",
          berlin,
        ),
      ],
    },
  ];
}

// ── Listing ──────────────────────────────────────────────────────────

/** Whether an event reaches past `timeMin` (Google's `timeMin` filters on the end). */
function endsAfter(event: RemoteEvent, timeMin: number): boolean {
  if (event.status === "cancelled") return true;
  const times = eventTimes(event, "UTC");
  if (times === null) return true;
  if ((event.recurrence?.length ?? 0) > 0) {
    const end = recurrenceEnd(recurrenceSeriesOf(event, times));
    return end === null || end > timeMin;
  }
  return times.end > timeMin;
}

export interface DemoPageCursor {
  readonly fixed: number;
  readonly day: DayNumber;
}

/** One page of a calendar's events from `cursor`, at most about `size` events. */
export function demoEventsPage(
  source: DemoCalendarSource,
  cursor: DemoPageCursor,
  timeMin: number | null,
  size: number,
): { readonly events: ReadonlyArray<RemoteEvent>; readonly next: DemoPageCursor | null } {
  const events: Array<RemoteEvent> = [];
  const keep = (event: RemoteEvent) => timeMin === null || endsAfter(event, timeMin);
  let fixed = cursor.fixed;
  while (fixed < source.fixed.length && events.length < size) {
    const event = source.fixed[fixed]!;
    if (keep(event)) events.push(event);
    fixed += 1;
  }
  let day = cursor.day;
  while (day < source.to && events.length < size) {
    for (const event of source.day(day)) if (keep(event)) events.push(event);
    day += 1;
  }
  const done = fixed >= source.fixed.length && day >= source.to;
  return { events, next: done ? null : { fixed, day } };
}

/** The first day a listing needs, skipping days that end before `timeMin`. */
export function firstDemoDay(source: DemoCalendarSource, timeMin: number | null): DayNumber {
  return timeMin === null ? source.from : Math.max(source.from, Math.floor(timeMin / DAY_MS) - 1);
}

/** The anchor Monday (UTC) for "now". */
export function anchorMonday(now: number): DayNumber {
  const today = Math.floor(now / DAY_MS);
  return today - ((weekday(today) + 6) % 7);
}
