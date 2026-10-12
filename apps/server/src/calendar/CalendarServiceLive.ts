// @effect-diagnostics globalDate:off - Google's RFC 3339 `timeMin` and `updated` stamps are formatted here.
/**
 * CalendarServiceLive - calendars in SQLite, synced from Google (or the demo source), streamed
 * to every subscriber.
 *
 * Writes are serialized by one lock. Network I/O (provider calls, sync pages) happens outside
 * it; only applying the results to SQLite and publishing happen under it, after the
 * transaction commits. Subscribers subscribe and take their snapshot under the same lock, so a
 * week stream never receives a change older than its snapshot.
 *
 * Events are stored as Google returns them and materialized into `calendar_instances` over a
 * horizon per calendar ([now - 1 year, now + 2 years] at first) that grows a year at a time
 * when a client asks for weeks outside it. A change re-materializes only the series it touched
 * and publishes the diff; changes over `LARGE_CHANGE` rows (a full resync) publish a
 * replacement of the calendar instead, which each week stream answers with that calendar's
 * instances in its week.
 *
 * Sync runs per account: every minute while a client is subscribed, at most every fifteen
 * minutes otherwise, right after an account connects, and on demand. Calendars nobody watches
 * (hidden, or no subscriber) skip `events.list` when they synced less than fifteen minutes ago.
 * Rate limits and outages back off (1, 2, 5, 15 minutes) and show as the account's error; a
 * revoked sign-in stops the account until it connects again.
 *
 * Demo seeding: when `T3CODE_CALENDAR_DEMO` is set (`standard`, `massive`, or `<profile>:<seed>`,
 * e.g. `massive:7`) and there are no accounts yet, the demo accounts are added at startup.
 *
 * @module CalendarServiceLive
 */
import {
  CalendarError,
  DEFAULT_CALENDAR_PREFERENCES,
  type Calendar,
  type CalendarAccount,
  type CalendarChangeStep,
  type CalendarDirectory,
  type CalendarEventDetails,
  type CalendarEventInstance,
  type CalendarMutationResult,
  type CalendarPreferences,
  type CalendarWeekEvent,
  type GoogleConnectState,
} from "@t3tools/contracts";
import {
  expandRecurrence,
  occurrenceId,
  parseOccurrenceId,
  recurrenceBefore,
  recurrenceFrom,
} from "@t3tools/shared/calendar/recurrence";
import {
  DAY_MS,
  fromZoned,
  isValidTimeZone,
  parseDayNumber,
  systemTimeZone,
  toZoned,
  weekday,
} from "@t3tools/shared/calendar/time";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { CalendarService, type CalendarServiceShape } from "./CalendarService.ts";
import {
  makeCalendarStore,
  type AccountRecord,
  type CalendarRecord,
  type StoredEvent,
} from "./CalendarStore.ts";
import {
  createWrite,
  fieldPatch,
  isEmptyPatch,
  occurrenceEvent,
  previousFieldsAndTime,
  seriesCopy,
  shiftWeeklyDays,
  withResponse,
} from "./changes.ts";
import { DEFAULT_DEMO_SEED, demoAccounts, type DemoProfile } from "./demo/demoData.ts";
import { makeDemoClient } from "./demo/DemoProvider.ts";
import {
  WEEK_MS,
  canRespond,
  eventDetails,
  eventTimes,
  instanceKey,
  isReadOnly,
  isReadOnlyRole,
  originalStartOf,
  parseTimeInput,
  sameInstanceRow,
  selfAttendee,
  toInstance,
  toRemoteDateTime,
  zoneOr,
  type EventTimes,
  type InstanceRow,
} from "./eventModel.ts";
import { freeSlots, mergeBusy, workingWindows } from "./freeTime.ts";
import { GoogleAuth, type GoogleIdentity } from "./google/GoogleAuth.ts";
import { materializeSeries, recurrenceSeriesOf, seriesKeyOf } from "./materialize.ts";
import {
  CalendarProviderError,
  type CalendarProviderClient,
  type RemoteCalendar,
  type RemoteEvent,
  type RemoteEventWrite,
} from "./providers/CalendarProvider.ts";

const MINUTE = 60_000;
const YEAR_MS = 52 * WEEK_MS;
/** Changes above this many instances replace the calendar in open weeks instead of a diff. */
const LARGE_CHANGE = 500;
const ACTIVE_SYNC_INTERVAL = MINUTE;
const IDLE_SYNC_INTERVAL = 15 * MINUTE;
/** Calendars nobody watches skip `events.list` when they synced this recently. */
const UNWATCHED_CALENDAR_INTERVAL = 15 * MINUTE;
const CALENDAR_LIST_INTERVAL = 5 * MINUTE;
const FRESH_FOR_AGENT = 5 * MINUTE;
const AGENT_SYNC_WAIT = Duration.seconds(10);
const BACKOFF = [1, 2, 5, 15].map((minutes) => minutes * MINUTE);
/** The directory republishes a newer `lastSyncedAt` at most this often. */
const LAST_SYNCED_REFRESH = 5 * MINUTE;
const MAX_PAGES = 2000;
const FREE_SLOT_LIMIT = 100;
const MAX_FREE_TIME_RANGE = 62 * DAY_MS;

export interface CalendarServiceOptions {
  /** Simulated latency of demo writes (80–150 ms). Tests turn it off. */
  readonly demoLatency?: boolean;
  /** The background sync schedule. Tests turn it off and sync explicitly. */
  readonly autoSync?: boolean;
  readonly beforeAutoSync?: Effect.Effect<void>;
}

/** A published change of one calendar's instances. */
type CalendarChange =
  | {
      readonly _tag: "instances";
      readonly calendarId: string;
      readonly changes: ReadonlyArray<InstanceChange>;
    }
  /** Re-read the calendar (visibility, a full resync, a large change, removal). */
  | { readonly _tag: "replace"; readonly calendarId: string };

interface InstanceChange {
  readonly key: string;
  /** Times before the change, when the instance existed. */
  readonly previous?: { readonly start: number; readonly end: number };
  /** The instance now; absent when it was removed. */
  readonly instance?: CalendarEventInstance;
}

interface SyncTimer {
  lastAttempt: number;
  failures: number;
  retryAt: number;
  listFetchedAt: number;
}

interface Target {
  readonly calendar: CalendarRecord;
  readonly account: AccountRecord;
  readonly client: CalendarProviderClient;
}

type Resolved =
  | {
      readonly kind: "single" | "master";
      readonly stored: StoredEvent;
      readonly current: RemoteEvent;
      readonly times: EventTimes;
    }
  | {
      readonly kind: "occurrence";
      readonly instanceId: string;
      readonly seriesId: string;
      readonly master: StoredEvent | undefined;
      readonly exception: StoredEvent | undefined;
      readonly current: RemoteEvent;
      readonly times: EventTimes;
      readonly originalStart: number;
      readonly masterTimes: EventTimes | null;
    };

const invalid = (detail: string) => new CalendarError({ code: "invalid", detail });
const notFound = (detail = "That event does not exist.") =>
  new CalendarError({ code: "not_found", detail });
const readOnly = (detail = "You can't change this event here.") =>
  new CalendarError({ code: "read_only", detail });

const PROVIDER_CODES = {
  gone: "conflict",
  rate_limited: "rate_limited",
  signed_out: "signed_out",
  not_found: "not_found",
  forbidden: "read_only",
  invalid: "invalid",
  conflict: "conflict",
  unavailable: "unavailable",
  failed: "failed",
} as const satisfies Record<CalendarProviderError["reason"], CalendarError["code"]>;

const fromProvider = (error: CalendarProviderError) =>
  new CalendarError({ code: PROVIDER_CODES[error.reason], detail: error.detail });

/** Logs storage failures and answers with an error a client can show. */
const failedTo =
  (action: string) =>
  <A, E, R>(effect: Effect.Effect<A, E | SqlError, R>) =>
    Effect.catchTag(effect, "SqlError", (error) =>
      Effect.logError(`Could not ${action}.`, Cause.pretty(Cause.fail(error))).pipe(
        Effect.andThen(
          Effect.fail(new CalendarError({ code: "failed", detail: `Could not ${action}.` })),
        ),
      ),
    );

/** Directories are small; comparing their JSON skips repeats of an unchanged snapshot. */
function sameDirectory(a: CalendarDirectory, b: CalendarDirectory): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const iso = (ms: number) => new Date(ms).toISOString();

function syncErrorMessage(error: CalendarProviderError, retryInMs: number): string {
  const minutes = Math.round(retryInMs / MINUTE);
  const retry = `Retrying in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  switch (error.reason) {
    case "rate_limited":
      return `Google is limiting requests right now. ${retry}`;
    case "unavailable":
      return `Google Calendar could not be reached. ${retry}`;
    default:
      return `${error.detail} ${retry}`;
  }
}

function parseDemoSetting(value: string): { profile: DemoProfile; seed: number } | null {
  const [profile, seedText] = value.trim().split(":");
  if (profile !== "standard" && profile !== "massive") return null;
  const seed = seedText === undefined || seedText === "" ? DEFAULT_DEMO_SEED : Number(seedText);
  return Number.isInteger(seed) ? { profile, seed } : null;
}

function mondayOf(ms: number): number {
  const day = Math.floor(ms / DAY_MS);
  return (day - ((weekday(day) + 6) % 7)) * DAY_MS;
}

const make = Effect.fn("CalendarServiceLive.make")(function* (
  options: CalendarServiceOptions = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const googleAuth = yield* GoogleAuth;
  const store = makeCalendarStore(sql);
  const layerScope = yield* Effect.scope;
  const writes = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<CalendarChange>();
  const directoryChanges = yield* PubSub.unbounded<number>();
  const wakeups = yield* Queue.sliding<number>(1);
  const serverZone = systemTimeZone();
  const demoClients = new Map<string, CalendarProviderClient>();
  const timers = new Map<string, SyncTimer>();
  const running = new Map<string, Deferred.Deferred<void>>();
  let subscribers = 0;
  let directoryRevision = 0;

  let preferences: CalendarPreferences = {
    ...DEFAULT_CALENDAR_PREFERENCES,
    ...(yield* store.readPreferences.pipe(Effect.orDie)),
  };

  const wake = Queue.offer(wakeups, 0).pipe(Effect.asVoid);
  const publishDirectory = Effect.suspend(() =>
    PubSub.publish(directoryChanges, ++directoryRevision),
  ).pipe(Effect.asVoid);

  const zoneFor = (calendar: CalendarRecord | undefined) =>
    zoneOr(calendar?.timeZone ?? undefined, zoneOr(preferences.timeZone ?? undefined, serverZone));

  const timerFor = (accountId: string) => {
    let timer = timers.get(accountId);
    if (timer === undefined) {
      timer = { lastAttempt: 0, failures: 0, retryAt: 0, listFetchedAt: 0 };
      timers.set(accountId, timer);
    }
    return timer;
  };

  const shortId = Effect.gen(function* () {
    const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
    let id = "";
    for (let index = 0; index < 10; index += 1) {
      id += alphabet[yield* Random.nextIntBetween(0, 35)];
    }
    return id;
  });

  /** Conference request ids: unique per request across restarts. */
  const requestPrefix = yield* shortId;
  let requestCounter = 0;
  const nextRequestId = () => `otter-${requestPrefix}-${++requestCounter}`;

  // ── Provider clients ─────────────────────────────────────────────

  const clientFor = (account: AccountRecord): CalendarProviderClient => {
    if (account.provider === "google") return googleAuth.client(account.externalId);
    let client = demoClients.get(account.accountId);
    if (client === undefined) {
      client = makeDemoClient({
        profile: account.demoProfile === "massive" ? "massive" : "standard",
        seed: account.demoSeed ?? DEFAULT_DEMO_SEED,
        accountIndex: account.demoIndex ?? 0,
        latency: options.demoLatency ?? true,
      });
      demoClients.set(account.accountId, client);
    }
    return client;
  };

  const markSignedOut = (accountId: string) =>
    store
      .setAccountStatus(accountId, "signed_out", "Sign in again to keep this account in sync.")
      .pipe(Effect.andThen(publishDirectory), Effect.ignore);

  /** Maps a provider failure for the caller; a revoked sign-in also marks the account. */
  const call = <A>(account: AccountRecord, effect: Effect.Effect<A, CalendarProviderError>) =>
    effect.pipe(
      Effect.catchTag("CalendarProviderError", (error: CalendarProviderError) =>
        (error.reason === "signed_out" ? markSignedOut(account.accountId) : Effect.void).pipe(
          Effect.andThen(Effect.fail(fromProvider(error))),
        ),
      ),
    );

  // ── Directory ────────────────────────────────────────────────────

  const toAccount = (account: AccountRecord): CalendarAccount => ({
    accountId: account.accountId as CalendarAccount["accountId"],
    provider: account.provider,
    email: account.email,
    displayName: account.displayName,
    ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}),
    status: account.status,
    ...(account.error ? { error: account.error } : {}),
    ...(account.lastSyncedAt !== null ? { lastSyncedAt: account.lastSyncedAt } : {}),
    position: account.position,
  });

  const toCalendar = (calendar: CalendarRecord): Calendar => ({
    calendarId: calendar.calendarId as Calendar["calendarId"],
    accountId: calendar.accountId as Calendar["accountId"],
    name: calendar.name,
    ...(calendar.description ? { description: calendar.description } : {}),
    color: calendar.color,
    accessRole: calendar.accessRole,
    primary: calendar.primary,
    visible: calendar.visible,
    ...(calendar.timeZone ? { timeZone: calendar.timeZone } : {}),
  });

  const loadDirectory = Effect.gen(function* () {
    const accounts = yield* store.listAccounts;
    const calendars = yield* store.listCalendars;
    const google = yield* googleAuth.clientStatus;
    const directory: CalendarDirectory = {
      accounts: accounts.map(toAccount),
      calendars: calendars.map(toCalendar),
      preferences,
      google,
    };
    return directory;
  });

  const getDirectory = loadDirectory.pipe(failedTo("load the calendars"));

  /** Counts open directory and week streams; the first one speeds up the sync schedule. */
  const trackSubscriber = Effect.acquireRelease(
    Effect.suspend(() => {
      subscribers += 1;
      return subscribers === 1 ? wake : Effect.void;
    }),
    () =>
      Effect.sync(() => {
        subscribers -= 1;
      }),
  );

  const directory: CalendarServiceShape["directory"] = Stream.unwrap(
    Effect.gen(function* () {
      yield* trackSubscriber;
      const subscription = yield* PubSub.subscribe(directoryChanges);
      const first = yield* getDirectory;
      const later = Stream.merge(
        Stream.fromSubscription(subscription),
        googleAuth.clientChanges.pipe(Stream.map(() => 0)),
      ).pipe(Stream.mapEffect(() => getDirectory));
      let last = first;
      return Stream.concat(
        Stream.make(first),
        later.pipe(
          Stream.filter((next) => {
            if (sameDirectory(last, next)) return false;
            last = next;
            return true;
          }),
        ),
      );
    }),
  );

  // ── Materialization ──────────────────────────────────────────────

  const publishChanges = (calendarId: string, list: ReadonlyArray<InstanceChange>) => {
    if (list.length === 0) return Effect.void;
    const change: CalendarChange =
      list.length > LARGE_CHANGE
        ? { _tag: "replace", calendarId }
        : { _tag: "instances", calendarId, changes: list };
    return PubSub.publish(changes, change).pipe(Effect.asVoid);
  };

  const publishReplace = (calendarId: string) =>
    PubSub.publish(changes, { _tag: "replace", calendarId }).pipe(Effect.asVoid);

  /** Writes the difference between a series' stored rows and `next`; returns the changes. */
  const writeDiff = (
    calendarId: string,
    previous: ReadonlyArray<InstanceRow>,
    next: ReadonlyArray<InstanceRow>,
  ) =>
    Effect.gen(function* () {
      const old = new Map(previous.map((row) => [row.instanceId, row]));
      const unique = new Map(next.map((row) => [row.instanceId, row]));
      const upserts: Array<InstanceRow> = [];
      const list: Array<InstanceChange> = [];
      for (const row of unique.values()) {
        const before = old.get(row.instanceId);
        old.delete(row.instanceId);
        if (before !== undefined && sameInstanceRow(before, row)) continue;
        upserts.push(row);
        list.push({
          key: instanceKey(row),
          instance: toInstance(row),
          ...(before ? { previous: { start: before.start, end: before.end } } : {}),
        });
      }
      for (const removed of old.values()) {
        list.push({
          key: instanceKey(removed),
          previous: { start: removed.start, end: removed.end },
        });
      }
      yield* store.deleteInstances(calendarId, [...old.keys()]);
      yield* store.upsertInstances(upserts);
      return list;
    });

  /** Re-materializes the given series of a calendar over its horizon. */
  const rematerialize = (calendar: CalendarRecord, keys: Iterable<string>) =>
    Effect.gen(function* () {
      const list: Array<InstanceChange> = [];
      for (const key of keys) {
        const { master, exceptions } = yield* store.seriesEvents(calendar.calendarId, key);
        const rows = materializeSeries({
          calendarId: calendar.calendarId,
          key,
          master: master?.event,
          exceptions: exceptions.map((entry) => entry.event),
          role: calendar.accessRole,
          zone: zoneFor(calendar),
          horizon: { start: calendar.horizonStart, end: calendar.horizonEnd },
        });
        const previous = yield* store.instancesOfSource(calendar.calendarId, key);
        list.push(...(yield* writeDiff(calendar.calendarId, previous, rows)));
      }
      return list;
    });

  /**
   * Stores events of one calendar and re-materializes the series they belong to. Cancelled
   * exceptions stay stored (they remove their occurrence); other cancelled events are
   * deletions and keep their details as a tombstone for restoring. Runs under the lock.
   */
  const applyEvents = (
    calendar: CalendarRecord,
    upserts: ReadonlyArray<RemoteEvent>,
    skipStale: boolean,
  ) =>
    Effect.gen(function* () {
      const toStore: Array<RemoteEvent> = [];
      const keys = new Set<string>();
      for (const incoming of upserts) {
        const stored = yield* store.getEvent(calendar.calendarId, incoming.id);
        if (skipStale && stored?.updatedMs != null) {
          const incomingUpdated = incoming.updated ? Date.parse(incoming.updated) : Number.NaN;
          if (!Number.isNaN(incomingUpdated) && incomingUpdated < stored.updatedMs) continue;
        }
        let event = incoming;
        if (incoming.status === "cancelled") {
          if (stored === undefined && incoming.recurringEventId === undefined) continue;
          if (stored !== undefined) event = { ...stored.event, ...incoming };
        }
        toStore.push(event);
        keys.add(seriesKeyOf(event));
        if (stored !== undefined) keys.add(seriesKeyOf(stored.event));
      }
      if (toStore.length === 0) return [];
      yield* store.upsertEvents(calendar.calendarId, toStore, zoneFor(calendar));
      return yield* rematerialize(calendar, keys);
    });

  /** Applies events to a calendar in one transaction and publishes the diff. */
  const applyLocal = (calendarId: string, events: ReadonlyArray<RemoteEvent>) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const calendar = yield* store.getCalendar(calendarId);
        if (calendar === undefined) return;
        const list = yield* sql.withTransaction(applyEvents(calendar, events, false));
        yield* publishChanges(calendarId, list);
      }),
    );

  /** Replaces all of a calendar's events (a full sync), atomically. */
  const replaceEvents = (calendar: CalendarRecord, events: ReadonlyArray<RemoteEvent>) =>
    Effect.gen(function* () {
      const kept = events.filter(
        (event) => event.status !== "cancelled" || event.recurringEventId !== undefined,
      );
      const zone = zoneFor(calendar);
      const groups = new Map<string, { master?: RemoteEvent; exceptions: Array<RemoteEvent> }>();
      for (const event of kept) {
        const key = seriesKeyOf(event);
        let group = groups.get(key);
        if (group === undefined) {
          group = { exceptions: [] };
          groups.set(key, group);
        }
        if (event.recurringEventId !== undefined) group.exceptions.push(event);
        else group.master = event;
      }
      const rows: Array<InstanceRow> = [];
      for (const [key, group] of groups) {
        rows.push(
          ...materializeSeries({
            calendarId: calendar.calendarId,
            key,
            master: group.master,
            exceptions: group.exceptions,
            role: calendar.accessRole,
            zone,
            horizon: { start: calendar.horizonStart, end: calendar.horizonEnd },
          }),
        );
      }
      yield* store.clearCalendar(calendar.calendarId);
      yield* store.upsertEvents(calendar.calendarId, kept, zone);
      yield* store.upsertInstances(rows);
    });

  /** Grows the horizon of every calendar to cover [from, to), a year at a time. */
  const ensureHorizon = (from: number, to: number) =>
    Effect.gen(function* () {
      const calendars = yield* store.listCalendars;
      if (calendars.every((entry) => entry.horizonStart <= from && entry.horizonEnd >= to)) return;
      yield* writes.withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            for (const stale of yield* store.listCalendars) {
              if (stale.horizonStart <= from && stale.horizonEnd >= to) continue;
              const start =
                from < stale.horizonStart
                  ? Math.min(mondayOf(from), stale.horizonStart - YEAR_MS)
                  : stale.horizonStart;
              const end =
                to > stale.horizonEnd
                  ? Math.max(mondayOf(to) + WEEK_MS, stale.horizonEnd + YEAR_MS)
                  : stale.horizonEnd;
              const ranges = [
                ...(start < stale.horizonStart ? [{ start, end: stale.horizonStart }] : []),
                ...(end > stale.horizonEnd ? [{ start: stale.horizonEnd, end }] : []),
              ];
              for (const range of ranges) {
                const keys = yield* store.masterKeysReaching(
                  stale.calendarId,
                  range.start,
                  range.end,
                );
                const rows: Array<InstanceRow> = [];
                for (const key of keys) {
                  const { master, exceptions } = yield* store.seriesEvents(stale.calendarId, key);
                  rows.push(
                    ...materializeSeries({
                      calendarId: stale.calendarId,
                      key,
                      master: master?.event,
                      exceptions: exceptions.map((entry) => entry.event),
                      role: stale.accessRole,
                      zone: zoneFor(stale),
                      horizon: range,
                    }),
                  );
                }
                yield* store.upsertInstances(rows);
              }
              yield* store.setHorizon(stale.calendarId, start, end);
            }
          }),
        ),
      );
    });

  // ── Week streams ─────────────────────────────────────────────────

  const overlaps = (start: number, end: number, from: number, to: number) =>
    start < to && (end > from || (end === start && start >= from));

  const week: CalendarServiceShape["week"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const day = parseDayNumber(input.week);
        if (day === null || weekday(day) !== 1) {
          return yield* invalid("A week starts on a Monday, given as YYYY-MM-DD.");
        }
        const from = day * DAY_MS;
        const to = from + WEEK_MS;
        yield* trackSubscriber;
        yield* ensureHorizon(from, to);
        const { subscription, snapshot, visible } = yield* writes.withPermits(1)(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(changes);
            const visible = new Set(yield* store.visibleCalendarIds);
            const rows = yield* store.rangeInstances([...visible], from, to);
            return { subscription, snapshot: rows.map(toInstance), visible };
          }),
        );

        const replaced = (calendarId: string) =>
          Effect.gen(function* () {
            const calendar = yield* store.getCalendar(calendarId);
            const shown = calendar?.visible === true;
            const events: Array<CalendarWeekEvent> = [];
            if (!shown && !visible.has(calendarId)) return events;
            let instances: Array<CalendarEventInstance> = [];
            if (shown) {
              visible.add(calendarId);
              yield* ensureHorizon(from, to);
              instances = (yield* store.rangeInstances([calendarId], from, to)).map(toInstance);
            } else {
              visible.delete(calendarId);
            }
            events.push({
              _tag: "calendarReplaced",
              calendarId: calendarId as Calendar["calendarId"],
              instances,
            });
            return events;
          });

        const eventsFor = (change: CalendarChange) => {
          if (change._tag === "replace") return replaced(change.calendarId);
          if (!visible.has(change.calendarId)) return Effect.succeed([]);
          const upserted: Array<CalendarEventInstance> = [];
          const removed: Array<string> = [];
          for (const entry of change.changes) {
            if (entry.instance && overlaps(entry.instance.start, entry.instance.end, from, to)) {
              upserted.push(entry.instance);
            } else if (
              entry.previous &&
              overlaps(entry.previous.start, entry.previous.end, from, to)
            ) {
              removed.push(entry.key);
            }
          }
          const events: Array<CalendarWeekEvent> = [];
          if (upserted.length > 0) events.push({ _tag: "upserted", instances: upserted });
          if (removed.length > 0) events.push({ _tag: "removed", keys: removed });
          return Effect.succeed(events);
        };

        const first: CalendarWeekEvent = { _tag: "snapshot", instances: snapshot };
        return Stream.concat(
          Stream.make(first),
          Stream.fromSubscription(subscription).pipe(
            Stream.mapEffect((change) => eventsFor(change).pipe(failedTo("load the week"))),
            Stream.flattenIterable,
          ),
        );
      }).pipe(failedTo("load the week")),
    );

  const listInstances: CalendarServiceShape["listInstances"] = (input) =>
    Effect.gen(function* () {
      if (!(input.end > input.start))
        return yield* invalid("The range has to end after it starts.");
      yield* ensureHorizon(input.start, input.end);
      const calendarIds = input.calendarIds ?? (yield* store.visibleCalendarIds);
      const rows = yield* store.rangeInstances(calendarIds, input.start, input.end);
      return rows.map(toInstance);
    }).pipe(failedTo("load the events"));

  // ── Resolving events ─────────────────────────────────────────────

  const resolveTarget = (calendarId: string) =>
    Effect.gen(function* () {
      const calendar = yield* store.getCalendar(calendarId);
      if (calendar === undefined) return yield* notFound("That calendar does not exist.");
      const account = yield* store.getAccount(calendar.accountId);
      if (account === undefined) return yield* notFound("That calendar does not exist.");
      const target: Target = { calendar, account, client: clientFor(account) };
      return target;
    });

  const resolveEvent = (calendar: CalendarRecord, eventId: string, allowCancelled = false) =>
    Effect.gen(function* () {
      const zone = zoneFor(calendar);
      const stored = yield* store.getEvent(calendar.calendarId, eventId);
      if (stored !== undefined && stored.kind !== "exception") {
        if (stored.status === "cancelled" && !allowCancelled) return yield* notFound();
        const times = eventTimes(stored.event, zone);
        if (times === null) return yield* notFound();
        const resolved: Resolved = { kind: stored.kind, stored, current: stored.event, times };
        return resolved;
      }
      const parsed = stored === undefined ? parseOccurrenceId(eventId) : null;
      const seriesId = stored?.seriesId ?? parsed?.seriesId;
      if (seriesId === undefined) return yield* notFound();
      const masterRow = yield* store.getEvent(calendar.calendarId, seriesId);
      const master = masterRow?.kind === "master" ? masterRow : undefined;
      if (master?.status === "cancelled" && !allowCancelled) return yield* notFound();
      const masterTimes = master === undefined ? null : eventTimes(master.event, zone);
      const seriesZone = masterTimes?.timeZone ?? zone;

      if (stored !== undefined) {
        if (stored.status === "cancelled" && !allowCancelled) return yield* notFound();
        const originalStart = originalStartOf(stored.event, seriesZone);
        let current = stored.event;
        if (
          current.start === undefined &&
          master !== undefined &&
          masterTimes !== null &&
          originalStart !== null
        ) {
          // A cancelled exception carries only ids: the occurrence comes from its series.
          current = {
            ...occurrenceEvent(
              master.event,
              eventId,
              { start: originalStart, end: originalStart + (masterTimes.end - masterTimes.start) },
              masterTimes.allDay,
              seriesZone,
            ),
            status: stored.event.status ?? "confirmed",
          };
        }
        const times = eventTimes(current, seriesZone);
        if (times === null) return yield* notFound();
        const resolved: Resolved = {
          kind: "occurrence",
          instanceId: eventId,
          seriesId,
          master,
          exception: stored,
          current,
          times,
          originalStart: originalStart ?? times.start,
          masterTimes,
        };
        return resolved;
      }

      if (master === undefined || masterTimes === null || parsed === null) return yield* notFound();
      const occurrence = expandRecurrence(
        recurrenceSeriesOf(master.event, masterTimes),
        parsed.start,
        parsed.start + 1,
        50,
      ).find((entry) => entry.start === parsed.start);
      if (occurrence === undefined) return yield* notFound();
      const resolved: Resolved = {
        kind: "occurrence",
        instanceId: eventId,
        seriesId,
        master,
        exception: undefined,
        current: occurrenceEvent(master.event, eventId, occurrence, masterTimes.allDay, seriesZone),
        times: { ...occurrence, allDay: masterTimes.allDay, timeZone: seriesZone },
        originalStart: occurrence.start,
        masterTimes,
      };
      return resolved;
    });

  const detailsOf = (target: Target, resolved: Resolved): CalendarEventDetails =>
    eventDetails(resolved.current, {
      calendarId: target.calendar.calendarId,
      eventId: resolved.kind === "occurrence" ? resolved.instanceId : resolved.stored.eventId,
      seriesId:
        resolved.kind === "occurrence"
          ? resolved.seriesId
          : resolved.kind === "master"
            ? resolved.stored.eventId
            : null,
      role: target.calendar.accessRole,
      times: resolved.times,
      recurrence:
        resolved.kind === "occurrence"
          ? resolved.master?.event.recurrence
          : resolved.current.recurrence,
      originalStart: resolved.kind === "occurrence" ? resolved.originalStart : null,
      google: target.account.provider === "google",
    });

  /** The first of `eventIds` that resolves now, as details (after a change). */
  const resultEvent = (calendarId: string, eventIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(calendarId);
      for (const eventId of eventIds) {
        const resolved = yield* resolveEvent(target.calendar, eventId).pipe(Effect.option);
        if (Option.isSome(resolved)) return detailsOf(target, resolved.value);
      }
      return undefined;
    });

  const mutationResult = (
    event: CalendarEventDetails | undefined,
    undo: ReadonlyArray<CalendarChangeStep>,
  ): CalendarMutationResult => (event === undefined ? { undo } : { event, undo });

  const getEvent: CalendarServiceShape["getEvent"] = (input) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(input.calendarId);
      return detailsOf(target, yield* resolveEvent(target.calendar, input.eventId));
    }).pipe(failedTo("load the event"));

  const ensureWritable = (target: Target, current: RemoteEvent) =>
    isReadOnly(current, target.calendar.accessRole)
      ? Effect.fail(
          readOnly(
            isReadOnlyRole(target.calendar.accessRole)
              ? "This calendar is read-only."
              : "Only the organizer can change this event.",
          ),
        )
      : Effect.void;

  // ── Create ───────────────────────────────────────────────────────

  const createEvent: CalendarServiceShape["createEvent"] = (input) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(input.calendarId);
      const { calendar, account, client } = target;
      if (isReadOnlyRole(calendar.accessRole))
        return yield* readOnly("This calendar is read-only.");
      const time = parseTimeInput(input.time, zoneFor(calendar));
      if (!time.ok) return yield* invalid(time.detail);
      const write: RemoteEventWrite = {
        ...createWrite(input, nextRequestId),
        start: toRemoteDateTime(time.start, time.allDay, time.zone),
        end: toRemoteDateTime(time.end, time.allDay, time.zone),
      };
      const created = yield* call(
        account,
        client.insertEvent(calendar.remoteId, write, sendUpdatesOf(input.sendUpdates)),
      );
      yield* applyLocal(calendar.calendarId, [created]);
      const event = yield* resultEvent(calendar.calendarId, [
        occurrenceId(created.id, time.start, time.allDay),
        created.id,
      ]);
      return mutationResult(event, [
        {
          _tag: "delete",
          input: {
            calendarId: input.calendarId,
            eventId: created.id,
            scope: "all",
            ...(input.sendUpdates ? { sendUpdates: input.sendUpdates } : {}),
          },
        },
      ]);
    }).pipe(failedTo("create the event"));

  // ── Update ───────────────────────────────────────────────────────

  const updateEvent: CalendarServiceShape["updateEvent"] = (input) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(input.calendarId);
      const { calendar, account, client } = target;
      const resolved = yield* resolveEvent(calendar, input.eventId);
      yield* ensureWritable(target, resolved.current);
      const scope = input.scope ?? "this";
      const sendUpdates = input.sendUpdates;
      const writeOptions = sendUpdatesOf(sendUpdates);
      const zone = zoneFor(calendar);

      const moving =
        input.targetCalendarId !== undefined && input.targetCalendarId !== input.calendarId;
      let destination: Target | undefined;
      if (moving) {
        destination = yield* resolveTarget(input.targetCalendarId!);
        if (destination.account.accountId !== account.accountId) {
          return yield* invalid("Events can only move between calendars of the same account.");
        }
        if (isReadOnlyRole(destination.calendar.accessRole)) {
          return yield* readOnly("The other calendar is read-only.");
        }
      }

      const undoBase = (eventId: string, scopeOfUndo: "this" | "all") => ({
        calendarId: moving ? input.targetCalendarId! : input.calendarId,
        eventId,
        scope: scopeOfUndo,
        ...(sendUpdates ? { sendUpdates } : {}),
        ...(moving ? { targetCalendarId: input.calendarId } : {}),
      });

      /** Moves a whole event (single or series) after its fields changed. */
      const moveWhole = (eventId: string, current: RemoteEvent) =>
        Effect.gen(function* () {
          const moved = yield* call(
            account,
            client.moveEvent(calendar.remoteId, eventId, destination!.calendar.remoteId, {
              ...writeOptions,
              current,
            }),
          );
          yield* moveLocal(calendar.calendarId, destination!.calendar.calendarId, eventId, moved);
        });

      /** Patches a stored single event or master directly. */
      const patchWhole = (
        eventId: string,
        current: RemoteEvent,
        times: EventTimes,
        undoScope: "this" | "all",
      ) =>
        Effect.gen(function* () {
          const patch = fieldPatch(input, current, nextRequestId);
          if (input.time !== undefined) {
            const time = parseTimeInput(input.time, times.allDay ? zone : times.timeZone);
            if (!time.ok) return yield* invalid(time.detail);
            patch.start = toRemoteDateTime(time.start, time.allDay, time.zone);
            patch.end = toRemoteDateTime(time.end, time.allDay, time.zone);
          }
          let result = current;
          if (!isEmptyPatch(patch)) {
            result = yield* call(
              account,
              client.patchEvent(calendar.remoteId, eventId, patch, { ...writeOptions, current }),
            );
            yield* applyLocal(calendar.calendarId, [result]);
          }
          if (moving) yield* moveWhole(eventId, result);
          const undo: CalendarChangeStep = {
            _tag: "update",
            input: {
              ...undoBase(eventId, undoScope),
              ...previousFieldsAndTime(input, current, zone),
            },
          };
          return [undo];
        });

      if (resolved.kind !== "occurrence") {
        const undo = yield* patchWhole(
          resolved.stored.eventId,
          resolved.current,
          resolved.times,
          "all",
        );
        const event = yield* resultEvent(destination?.calendar.calendarId ?? input.calendarId, [
          input.eventId,
        ]);
        return mutationResult(event, undo);
      }

      const master = resolved.master;
      if (master === undefined || resolved.masterTimes === null) {
        // An occurrence whose series is not in this calendar (an invitation to one instance).
        if (moving) return yield* invalid("This occurrence can't move to another calendar.");
        const undo = yield* patchWhole(
          resolved.instanceId,
          resolved.current,
          resolved.times,
          "this",
        );
        return mutationResult(yield* resultEvent(input.calendarId, [resolved.instanceId]), undo);
      }
      if (moving && scope !== "all") {
        return yield* invalid("Only a whole series can move to another calendar; use scope all.");
      }
      if (input.recurrence !== undefined && scope === "this") {
        return yield* invalid(
          "Changing how an event repeats applies to this and following events, or to all of them.",
        );
      }
      const masterTimes = resolved.masterTimes;
      const seriesZone = masterTimes.timeZone;

      if (scope === "this") {
        const patch = fieldPatch(input, resolved.current, nextRequestId);
        if (input.time !== undefined) {
          const time = parseTimeInput(input.time, seriesZone);
          if (!time.ok) return yield* invalid(time.detail);
          patch.start = toRemoteDateTime(time.start, time.allDay, time.zone);
          patch.end = toRemoteDateTime(time.end, time.allDay, time.zone);
        }
        if (!isEmptyPatch(patch)) {
          const result = yield* call(
            account,
            client.patchEvent(calendar.remoteId, resolved.instanceId, patch, {
              ...writeOptions,
              current: resolved.current,
            }),
          );
          yield* applyLocal(calendar.calendarId, [
            { ...result, recurringEventId: result.recurringEventId ?? master.eventId },
          ]);
        }
        return mutationResult(yield* resultEvent(input.calendarId, [resolved.instanceId]), [
          {
            _tag: "update",
            input: {
              ...undoBase(resolved.instanceId, "this"),
              ...previousFieldsAndTime(input, resolved.current, seriesZone),
            },
          },
        ]);
      }

      /** The new start and end for the series, shifted like the edited occurrence. */
      const shifted = (anchorStart: number) => {
        if (input.time === undefined) return null;
        const time = parseTimeInput(input.time, seriesZone);
        if (!time.ok) return time;
        const localOf = (ms: number, allDay: boolean) =>
          allDay ? { day: Math.floor(ms / DAY_MS), minutes: 0 } : toZoned(ms, seriesZone);
        const before = localOf(resolved.times.start, resolved.times.allDay);
        const after = localOf(time.start, time.allDay);
        const dayDelta = after.day - before.day;
        const anchor = localOf(anchorStart, masterTimes.allDay);
        const start = time.allDay
          ? (anchor.day + dayDelta) * DAY_MS
          : fromZoned(anchor.day + dayDelta, after.minutes, time.zone);
        return {
          ok: true as const,
          start,
          end: start + (time.end - time.start),
          allDay: time.allDay,
          zone: time.zone,
          dayDelta,
        };
      };

      const isFirst = resolved.originalStart === masterTimes.start;
      if (scope === "all" || isFirst) {
        const current = master.event;
        const patch = fieldPatch(input, current, nextRequestId);
        const shift = shifted(masterTimes.start);
        if (shift !== null) {
          if (!shift.ok) return yield* invalid(shift.detail);
          patch.start = toRemoteDateTime(shift.start, shift.allDay, shift.zone);
          patch.end = toRemoteDateTime(shift.end, shift.allDay, shift.zone);
          if (input.recurrence === undefined && current.recurrence !== undefined) {
            const recurrence = shiftWeeklyDays(current.recurrence, shift.dayDelta);
            if (recurrence !== current.recurrence) patch.recurrence = [...recurrence];
          }
        }
        let result = current;
        if (!isEmptyPatch(patch)) {
          result = yield* call(
            account,
            client.patchEvent(calendar.remoteId, master.eventId, patch, {
              ...writeOptions,
              current,
            }),
          );
          yield* applyLocal(calendar.calendarId, [result]);
        }
        if (moving) yield* moveWhole(master.eventId, result);
        const previous = previousFieldsAndTime(input, current, seriesZone);
        const undo: CalendarChangeStep = {
          _tag: "update",
          input: {
            ...undoBase(master.eventId, "all"),
            ...previous,
            ...(patch.recurrence !== undefined ? { recurrence: current.recurrence ?? [] } : {}),
          },
        };
        const newStart = shift?.ok
          ? resolved.originalStart + (shift.start - masterTimes.start)
          : null;
        const event = yield* resultEvent(destination?.calendar.calendarId ?? input.calendarId, [
          ...(newStart === null
            ? [resolved.instanceId]
            : [
                occurrenceId(
                  master.eventId,
                  newStart,
                  shift?.ok ? shift.allDay : masterTimes.allDay,
                ),
              ]),
          resolved.instanceId,
          master.eventId,
        ]);
        return mutationResult(event, [undo]);
      }

      // "This and following": end the series before this occurrence and start a new one here.
      const series = recurrenceSeriesOf(master.event, masterTimes);
      const splitStart = resolved.originalStart;
      const shift = shifted(splitStart);
      if (shift !== null && !shift.ok) return yield* invalid(shift.detail);
      const newStart = shift?.start ?? splitStart;
      const newEnd = shift?.end ?? splitStart + (masterTimes.end - masterTimes.start);
      const newAllDay = shift?.allDay ?? masterTimes.allDay;
      const newZone = shift?.zone ?? seriesZone;
      const body: RemoteEventWrite = {
        ...seriesCopy(master.event, nextRequestId),
        ...fieldPatch(input, master.event, nextRequestId),
        start: toRemoteDateTime(newStart, newAllDay, newZone),
        end: toRemoteDateTime(newEnd, newAllDay, newZone),
        recurrence: [
          ...(input.recurrence ??
            shiftWeeklyDays(recurrenceFrom(series, splitStart), shift?.dayDelta ?? 0)),
        ],
      };
      const truncated = yield* call(
        account,
        client.patchEvent(
          calendar.remoteId,
          master.eventId,
          { recurrence: recurrenceBefore(series, splitStart) },
          { ...writeOptions, current: master.event },
        ),
      );
      const created = yield* call(
        account,
        client.insertEvent(calendar.remoteId, body, writeOptions),
      ).pipe(
        Effect.tapError(() =>
          // Put the original series back when the new one could not be created.
          client
            .patchEvent(
              calendar.remoteId,
              master.eventId,
              { recurrence: master.event.recurrence ?? [] },
              {
                ...writeOptions,
                current: truncated,
              },
            )
            .pipe(Effect.ignore),
        ),
      );
      yield* applyLocal(calendar.calendarId, [truncated, created]);
      const event = yield* resultEvent(input.calendarId, [
        occurrenceId(created.id, newStart, newAllDay),
        created.id,
      ]);
      return mutationResult(event, [
        {
          _tag: "delete",
          input: {
            calendarId: input.calendarId,
            eventId: created.id,
            scope: "all",
            ...(sendUpdates ? { sendUpdates } : {}),
          },
        },
        {
          _tag: "update",
          input: {
            calendarId: input.calendarId,
            eventId: master.eventId,
            scope: "all",
            recurrence: master.event.recurrence ?? [],
            ...(sendUpdates ? { sendUpdates } : {}),
          },
        },
      ]);
    }).pipe(failedTo("change the event"));

  /** Moves a series (or single event) and its exceptions between calendars locally. */
  const moveLocal = (fromId: string, toId: string, key: string, moved: RemoteEvent) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const from = yield* store.getCalendar(fromId);
        const to = yield* store.getCalendar(toId);
        if (from === undefined || to === undefined) return;
        const [fromChanges, toChanges] = yield* sql.withTransaction(
          Effect.gen(function* () {
            const { exceptions } = yield* store.seriesEvents(fromId, key);
            yield* store.deleteEvents(fromId, [key, ...exceptions.map((entry) => entry.eventId)]);
            yield* store.upsertEvents(
              toId,
              [moved, ...exceptions.map((entry) => entry.event)],
              zoneFor(to),
            );
            return [yield* rematerialize(from, [key]), yield* rematerialize(to, [key])] as const;
          }),
        );
        yield* publishChanges(fromId, fromChanges);
        yield* publishChanges(toId, toChanges);
      }),
    );

  // ── Delete and restore ───────────────────────────────────────────

  const deleteEvent: CalendarServiceShape["deleteEvent"] = (input) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(input.calendarId);
      const { calendar, account, client } = target;
      const resolved = yield* resolveEvent(calendar, input.eventId);
      yield* ensureWritable(target, resolved.current);
      const writeOptions = sendUpdatesOf(input.sendUpdates);
      const now = yield* Clock.currentTimeMillis;
      const tombstone = (event: RemoteEvent): RemoteEvent => ({
        ...event,
        status: "cancelled",
        updated: iso(now),
      });
      const restore = (eventId: string): CalendarChangeStep => ({
        _tag: "restore",
        input: { calendarId: input.calendarId, eventId },
      });

      const deleteWhole = (eventId: string, current: RemoteEvent) =>
        Effect.gen(function* () {
          yield* call(account, client.deleteEvent(calendar.remoteId, eventId, writeOptions));
          yield* applyLocal(calendar.calendarId, [tombstone(current)]);
          return mutationResult(undefined, [restore(eventId)]);
        });

      if (resolved.kind !== "occurrence")
        return yield* deleteWhole(resolved.stored.eventId, resolved.current);
      const scope = input.scope ?? "this";
      const master = resolved.master;
      if (master === undefined || resolved.masterTimes === null || scope === "this") {
        return yield* deleteWhole(resolved.instanceId, {
          ...resolved.current,
          recurringEventId: resolved.seriesId,
          originalStartTime:
            resolved.current.originalStartTime ??
            toRemoteDateTime(
              resolved.originalStart,
              resolved.times.allDay,
              resolved.times.timeZone,
            ),
        });
      }
      if (scope === "all" || resolved.originalStart === resolved.masterTimes.start) {
        return yield* deleteWhole(master.eventId, master.event);
      }
      const series = recurrenceSeriesOf(master.event, resolved.masterTimes);
      const truncated = yield* call(
        account,
        client.patchEvent(
          calendar.remoteId,
          master.eventId,
          { recurrence: recurrenceBefore(series, resolved.originalStart) },
          { ...writeOptions, current: master.event },
        ),
      );
      yield* applyLocal(calendar.calendarId, [truncated]);
      return mutationResult(undefined, [
        {
          _tag: "update",
          input: {
            calendarId: input.calendarId,
            eventId: master.eventId,
            scope: "all",
            recurrence: master.event.recurrence ?? [],
            ...(input.sendUpdates ? { sendUpdates: input.sendUpdates } : {}),
          },
        },
      ]);
    }).pipe(failedTo("delete the event"));

  const restoreEvent: CalendarServiceShape["restoreEvent"] = (input) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(input.calendarId);
      const { calendar, account, client } = target;
      const resolved = yield* resolveEvent(calendar, input.eventId, true);
      const eventId =
        resolved.kind === "occurrence" ? resolved.instanceId : resolved.stored.eventId;
      const undoScope = resolved.kind === "occurrence" ? "this" : "all";
      if (resolved.current.status !== "cancelled") {
        return mutationResult(yield* resultEvent(input.calendarId, [eventId]), []);
      }
      if (isReadOnlyRole(calendar.accessRole))
        return yield* readOnly("This calendar is read-only.");
      const result = yield* call(
        account,
        client.patchEvent(
          calendar.remoteId,
          eventId,
          { status: "confirmed" },
          {
            current: resolved.current,
          },
        ),
      );
      yield* applyLocal(calendar.calendarId, [
        resolved.kind === "occurrence"
          ? { ...result, recurringEventId: result.recurringEventId ?? resolved.seriesId }
          : result,
      ]);
      return mutationResult(yield* resultEvent(input.calendarId, [eventId]), [
        { _tag: "delete", input: { calendarId: input.calendarId, eventId, scope: undoScope } },
      ]);
    }).pipe(failedTo("restore the event"));

  // ── Respond ──────────────────────────────────────────────────────

  const respond: CalendarServiceShape["respond"] = (input) =>
    Effect.gen(function* () {
      const target = yield* resolveTarget(input.calendarId);
      const { calendar, account, client } = target;
      const resolved = yield* resolveEvent(calendar, input.eventId);
      const scope = input.scope ?? "this";
      const whole =
        resolved.kind === "occurrence" && scope === "all" && resolved.master !== undefined
          ? { eventId: resolved.master.eventId, current: resolved.master.event }
          : {
              eventId:
                resolved.kind === "occurrence" ? resolved.instanceId : resolved.stored.eventId,
              current: resolved.current,
            };
      const self = selfAttendee(whole.current);
      if (!canRespond(whole.current) || self === undefined) {
        return yield* invalid("Only guests can answer an invitation; you organize this event.");
      }
      const previousResponse = self.responseStatus ?? "needsAction";
      const result = yield* call(
        account,
        client.patchEvent(
          calendar.remoteId,
          whole.eventId,
          {
            attendeesOmitted: true,
            attendees: [{ email: self.email, responseStatus: input.response }],
          },
          { current: whole.current },
        ),
      );
      // Google may answer an RSVP patch with only the self attendee; keep the full list.
      const { attendeesOmitted: _omitted, ...answered } = result;
      const local: RemoteEvent = {
        ...answered,
        attendees:
          result.attendeesOmitted === true || result.attendees === undefined
            ? withResponse(whole.current.attendees ?? [], input.response)
            : result.attendees,
        ...(whole.current.attendeesOmitted === true ? { attendeesOmitted: true } : {}),
        ...(resolved.kind === "occurrence" &&
        whole.eventId === resolved.instanceId &&
        result.recurringEventId === undefined
          ? { recurringEventId: resolved.seriesId }
          : {}),
      };
      yield* applyLocal(calendar.calendarId, [local]);
      return mutationResult(yield* resultEvent(input.calendarId, [input.eventId, whole.eventId]), [
        {
          _tag: "respond",
          input: {
            calendarId: input.calendarId,
            eventId: input.eventId,
            response: previousResponse,
            scope,
          },
        },
      ]);
    }).pipe(failedTo("answer the invitation"));

  // ── Undo and redo ────────────────────────────────────────────────

  const applyChanges: CalendarServiceShape["applyChanges"] = (input) =>
    Effect.gen(function* () {
      let event: CalendarEventDetails | undefined;
      const inverse: Array<ReadonlyArray<CalendarChangeStep>> = [];
      for (const step of input.steps) {
        const result = yield* runStep(step);
        event = result.event;
        inverse.unshift(result.undo);
      }
      return mutationResult(event, inverse.flat());
    });

  const runStep = (
    step: CalendarChangeStep,
  ): Effect.Effect<CalendarMutationResult, CalendarError> => {
    switch (step._tag) {
      case "create":
        return createEvent(step.input);
      case "update":
        return updateEvent(step.input);
      case "delete":
        return deleteEvent(step.input);
      case "restore":
        return restoreEvent(step.input);
      case "respond":
        return respond(step.input);
    }
  };

  // ── Calendars, preferences, accounts ─────────────────────────────

  const updateCalendar: CalendarServiceShape["updateCalendar"] = (input) =>
    writes
      .withPermits(1)(
        Effect.gen(function* () {
          const calendar = yield* store.getCalendar(input.calendarId);
          if (calendar === undefined) return yield* notFound("That calendar does not exist.");
          if (input.visible !== undefined && input.visible !== calendar.visible) {
            yield* store.setCalendarVisible(input.calendarId, input.visible);
            yield* publishReplace(input.calendarId);
          }
          if (input.color !== undefined && input.color !== calendar.color) {
            yield* store.setCalendarColor(input.calendarId, input.color.toLowerCase());
          }
          yield* publishDirectory;
        }),
      )
      .pipe(failedTo("change the calendar"));

  const updatePreferences: CalendarServiceShape["updatePreferences"] = (patch) =>
    writes
      .withPermits(1)(
        Effect.gen(function* () {
          if (patch.timeZone != null && !isValidTimeZone(patch.timeZone)) {
            return yield* invalid(`Unknown time zone: ${patch.timeZone}.`);
          }
          if (
            patch.workingHours !== undefined &&
            patch.workingHours.end <= patch.workingHours.start
          ) {
            return yield* invalid("Working hours have to end after they start.");
          }
          if (
            patch.defaultCalendarId != null &&
            (yield* store.getCalendar(patch.defaultCalendarId)) === undefined
          ) {
            return yield* notFound("That calendar does not exist.");
          }
          const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
          yield* store.writePreferences(entries);
          preferences = {
            ...preferences,
            ...(Object.fromEntries(entries) as Partial<CalendarPreferences>),
          };
          yield* publishDirectory;
        }),
      )
      .pipe(failedTo("save the preferences"));

  const insertAccount = (
    fields: Omit<
      AccountRecord,
      "accountId" | "position" | "status" | "error" | "lastSyncedAt" | "calendarListSyncToken"
    >,
  ) =>
    Effect.gen(function* () {
      const accountId = yield* shortId;
      const now = yield* Clock.currentTimeMillis;
      yield* store.insertAccount(
        {
          ...fields,
          accountId,
          position: yield* store.nextAccountPosition,
          status: "syncing",
          error: null,
          lastSyncedAt: null,
          calendarListSyncToken: null,
        },
        now,
      );
      return accountId;
    });

  const addDemo: CalendarServiceShape["addDemo"] = (input) =>
    Effect.gen(function* () {
      const seed = input.seed ?? DEFAULT_DEMO_SEED;
      const added = yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const ids: Array<string> = [];
          for (const spec of demoAccounts(input.size, seed)) {
            const externalId = `${input.size}:${seed}:${spec.index}`;
            if ((yield* store.findAccount("demo", externalId)) !== undefined) continue;
            ids.push(
              yield* insertAccount({
                provider: "demo",
                externalId,
                email: spec.email,
                displayName: spec.displayName,
                avatarUrl: null,
                demoProfile: input.size,
                demoSeed: seed,
                demoIndex: spec.index,
              }),
            );
          }
          if (ids.length > 0) yield* publishDirectory;
          return ids;
        }),
      );
      for (const accountId of added) yield* startSync(accountId, true);
    }).pipe(failedTo("add the demo accounts"));

  const removeAccount: CalendarServiceShape["removeAccount"] = (accountId) =>
    Effect.gen(function* () {
      const account = yield* store.getAccount(accountId);
      if (account === undefined) return yield* notFound("That account does not exist.");
      yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const calendars = yield* store.calendarsOf(accountId);
          yield* sql.withTransaction(store.deleteAccount(accountId));
          for (const calendar of calendars) yield* publishReplace(calendar.calendarId);
          yield* publishDirectory;
        }),
      );
      timers.delete(accountId);
      demoClients.delete(accountId);
      if (account.provider === "google") yield* googleAuth.removeTokens(account.externalId);
    }).pipe(failedTo("remove the account"));

  // ── Google sign-in ───────────────────────────────────────────────

  const upsertGoogleAccount = (identity: GoogleIdentity) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const profile = {
          email: identity.email,
          displayName: identity.name ?? identity.email,
          avatarUrl: identity.picture ?? null,
        };
        const existing = yield* store.findAccount("google", identity.sub);
        let accountId: string;
        if (existing !== undefined) {
          accountId = existing.accountId;
          yield* store.updateAccountProfile(accountId, profile);
          yield* store.setAccountStatus(
            accountId,
            existing.lastSyncedAt === null ? "syncing" : "ok",
            null,
          );
          timers.delete(accountId);
        } else {
          accountId = yield* insertAccount({
            provider: "google",
            externalId: identity.sub,
            ...profile,
            demoProfile: null,
            demoSeed: null,
            demoIndex: null,
          });
        }
        yield* publishDirectory;
        return accountId;
      }),
    );

  const connect: CalendarServiceShape["connect"] = (input) =>
    googleAuth.connect(input).pipe(
      Stream.mapEffect((event): Effect.Effect<GoogleConnectState, CalendarError> => {
        switch (event._tag) {
          case "waiting":
            return Effect.succeed({
              _tag: "waiting",
              flowId: event.flowId,
              authorizationUrl: event.authorizationUrl,
              redirectUri: event.redirectUri,
            });
          case "exchanging":
            return Effect.succeed({ _tag: "exchanging" });
          case "failed":
            return Effect.succeed({ _tag: "failed", message: event.message });
          case "connected":
            return upsertGoogleAccount(event.identity).pipe(
              Effect.tap((accountId) => startSync(accountId, true)),
              Effect.map((accountId): GoogleConnectState => ({
                _tag: "succeeded",
                accountId: accountId as CalendarAccount["accountId"],
                email: event.identity.email,
              })),
              failedTo("add the Google account"),
            );
        }
      }),
    );

  // ── Sync ─────────────────────────────────────────────────────────

  const pagesOf = <Page extends { readonly nextPageToken?: string }>(
    fetch: (pageToken: string | undefined) => Effect.Effect<Page, CalendarProviderError>,
  ) =>
    Effect.gen(function* () {
      const pages: Array<Page> = [];
      let pageToken: string | undefined;
      do {
        const page = yield* fetch(pageToken);
        pages.push(page);
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined && pages.length < MAX_PAGES);
      return pages;
    });

  const syncCalendarList = (account: AccountRecord, client: CalendarProviderClient, now: number) =>
    Effect.gen(function* () {
      const list = (syncToken: string | null) =>
        pagesOf((pageToken) =>
          client.listCalendars({
            ...(syncToken !== null ? { syncToken } : {}),
            ...(pageToken !== undefined ? { pageToken } : {}),
          }),
        );
      let full = account.calendarListSyncToken === null;
      const pages = yield* list(account.calendarListSyncToken).pipe(
        Effect.catchIf(
          (error) => error.reason === "gone",
          () => {
            full = true;
            return list(null);
          },
        ),
      );
      const remotes: Array<RemoteCalendar> = pages.flatMap((page) => page.calendars);
      const nextSyncToken = pages.at(-1)?.nextSyncToken ?? null;
      yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* store.calendarsOf(account.accountId);
          const all = yield* store.listCalendars;
          const byRemote = new Map(existing.map((calendar) => [calendar.remoteId, calendar]));
          const seen = new Set<string>();
          const removed: Array<string> = [];
          const horizonStart = Math.min(
            mondayOf(now) - YEAR_MS,
            ...all.map((entry) => entry.horizonStart),
          );
          const horizonEnd = Math.max(
            mondayOf(now) + 2 * YEAR_MS,
            ...all.map((entry) => entry.horizonEnd),
          );
          let position = existing.length;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              for (const remote of remotes) {
                const local = byRemote.get(remote.id);
                seen.add(remote.id);
                if (remote.deleted === true) {
                  if (local !== undefined) {
                    yield* store.deleteCalendar(local.calendarId);
                    removed.push(local.calendarId);
                  }
                  continue;
                }
                const fields = {
                  name: remote.summaryOverride ?? remote.summary ?? remote.id,
                  description: remote.description ?? null,
                  color: /^#[0-9a-f]{6}$/i.test(remote.backgroundColor ?? "")
                    ? remote.backgroundColor!.toLowerCase()
                    : "#039be5",
                  accessRole: remote.accessRole ?? "reader",
                  primary: remote.primary === true,
                  timeZone:
                    remote.timeZone && isValidTimeZone(remote.timeZone) ? remote.timeZone : null,
                };
                if (local !== undefined) {
                  yield* store.updateCalendarFromRemote(local.calendarId, fields);
                  continue;
                }
                yield* store.insertCalendar({
                  calendarId: yield* shortId,
                  accountId: account.accountId,
                  remoteId: remote.id,
                  ...fields,
                  colorLocal: false,
                  visible: remote.hidden !== true && remote.selected !== false,
                  position: position++,
                  syncToken: null,
                  syncedAt: null,
                  horizonStart,
                  horizonEnd,
                });
              }
              if (full) {
                for (const calendar of existing) {
                  if (seen.has(calendar.remoteId)) continue;
                  yield* store.deleteCalendar(calendar.calendarId);
                  removed.push(calendar.calendarId);
                }
              }
              yield* store.setCalendarListSyncToken(account.accountId, nextSyncToken);
            }),
          );
          for (const calendarId of removed) yield* publishReplace(calendarId);
          yield* publishDirectory;
        }),
      );
    });

  const syncCalendarEvents = (
    account: AccountRecord,
    calendar: CalendarRecord,
    client: CalendarProviderClient,
    now: number,
  ) =>
    Effect.gen(function* () {
      const timeMin = iso(now - YEAR_MS);
      const list = (syncToken: string | null) =>
        pagesOf((pageToken) =>
          client.listEvents(calendar.remoteId, {
            ...(syncToken !== null ? { syncToken } : { timeMin }),
            ...(pageToken !== undefined ? { pageToken } : {}),
          }),
        );
      let full = calendar.syncToken === null;
      const pages = yield* list(calendar.syncToken).pipe(
        Effect.catchIf(
          (error) => error.reason === "gone",
          () => {
            full = true;
            return list(null);
          },
        ),
      );
      const events = pages.flatMap((page) => page.events);
      const nextSyncToken = pages.at(-1)?.nextSyncToken ?? null;
      yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const fresh = yield* store.getCalendar(calendar.calendarId);
          if (fresh === undefined) return;
          if (full) {
            yield* sql.withTransaction(
              replaceEvents(fresh, events).pipe(
                Effect.andThen(store.setCalendarSync(fresh.calendarId, nextSyncToken, now)),
              ),
            );
            yield* publishReplace(fresh.calendarId);
            return;
          }
          const list = yield* sql.withTransaction(
            applyEvents(fresh, events, true).pipe(
              Effect.tap(() => store.setCalendarSync(fresh.calendarId, nextSyncToken, now)),
            ),
          );
          yield* publishChanges(fresh.calendarId, list);
        }),
      );
    });

  /** One account's sync: its calendar list when due, then every calendar that needs it. */
  const syncAccountOnce = (account: AccountRecord, force: boolean, now: number) =>
    Effect.gen(function* () {
      const client = clientFor(account);
      const timer = timerFor(account.accountId);
      if (
        force ||
        account.calendarListSyncToken === null ||
        now - timer.listFetchedAt >= CALENDAR_LIST_INTERVAL
      ) {
        yield* syncCalendarList(account, client, now);
        timer.listFetchedAt = now;
      }
      for (const calendar of yield* store.calendarsOf(account.accountId)) {
        const watched = subscribers > 0 && calendar.visible;
        const recent =
          calendar.syncedAt !== null && now - calendar.syncedAt < UNWATCHED_CALENDAR_INTERVAL;
        if (!force && !watched && calendar.syncToken !== null && recent) continue;
        yield* syncCalendarEvents(account, calendar, client, now).pipe(
          Effect.catchIf(
            (error): error is CalendarProviderError =>
              error._tag === "CalendarProviderError" &&
              (error.reason === "not_found" || error.reason === "forbidden"),
            (error) =>
              Effect.logWarning("Skipped a calendar Google would not list.", {
                calendarId: calendar.calendarId,
                reason: error.reason,
              }),
          ),
        );
      }
    });

  const recordSyncResult = (
    account: AccountRecord,
    exit: Exit.Exit<void, CalendarProviderError | SqlError>,
    now: number,
  ) =>
    writes
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* store.getAccount(account.accountId);
          if (current === undefined) return;
          const timer = timerFor(account.accountId);
          if (Exit.isSuccess(exit)) {
            timer.failures = 0;
            timer.retryAt = 0;
            yield* store.setAccountStatus(account.accountId, "ok", null, now);
            const stale =
              current.lastSyncedAt === null || now - current.lastSyncedAt >= LAST_SYNCED_REFRESH;
            if (current.status !== "ok" || current.error !== null || stale) yield* publishDirectory;
            return;
          }
          const error = Cause.findErrorOption(exit.cause);
          const providerError =
            Option.isSome(error) && error.value._tag === "CalendarProviderError"
              ? error.value
              : undefined;
          if (providerError?.reason === "signed_out") {
            yield* store.setAccountStatus(
              account.accountId,
              "signed_out",
              "Sign in again to keep this account in sync.",
            );
            yield* publishDirectory;
            return;
          }
          if (providerError === undefined) {
            yield* Effect.logError("Calendar sync failed.", Cause.pretty(exit.cause));
          }
          timer.failures += 1;
          const delay = BACKOFF[Math.min(timer.failures, BACKOFF.length) - 1]!;
          timer.retryAt = now + delay;
          const message =
            providerError !== undefined
              ? syncErrorMessage(providerError, delay)
              : `Could not save the synced events. Retrying in ${Math.round(delay / MINUTE)} minutes.`;
          yield* store.setAccountStatus(account.accountId, "error", message);
          yield* publishDirectory;
        }),
      )
      .pipe(Effect.ignoreCause({ log: true }));

  /** Starts syncing an account unless it already is; answers with the run to wait for. */
  const startSync = (accountId: string, force: boolean) =>
    Effect.suspend(() => {
      const existing = running.get(accountId);
      if (existing !== undefined) return Effect.succeed(existing);
      const done = Deferred.makeUnsafe<void>();
      running.set(accountId, done);
      return Effect.gen(function* () {
        const account = yield* store
          .getAccount(accountId)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (account === undefined || account.status === "signed_out") return;
        const now = yield* Clock.currentTimeMillis;
        timerFor(accountId).lastAttempt = now;
        const exit = yield* Effect.exit(syncAccountOnce(account, force, now));
        yield* recordSyncResult(account, exit, now);
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            running.delete(accountId);
            return Deferred.succeed(done, undefined).pipe(Effect.andThen(wake));
          }),
        ),
        Effect.forkIn(layerScope),
        Effect.as(done),
      );
    });

  const sync: CalendarServiceShape["sync"] = (input) =>
    Effect.gen(function* () {
      const accounts =
        input.accountId !== undefined
          ? [yield* store.getAccount(input.accountId)]
          : yield* store.listAccounts;
      if (accounts[0] === undefined && input.accountId !== undefined) {
        return yield* notFound("That account does not exist.");
      }
      const runs = yield* Effect.forEach(
        accounts.filter((account): account is AccountRecord => account !== undefined),
        (account) => startSync(account.accountId, true),
      );
      yield* Effect.forEach(runs, (run) => Deferred.await(run), { discard: true });
    }).pipe(failedTo("sync the calendars"));

  const ensureFresh: CalendarServiceShape["ensureFresh"] = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const accounts = yield* store.listAccounts;
    const stale = accounts.filter(
      (account) =>
        account.status !== "signed_out" &&
        (account.lastSyncedAt === null || now - account.lastSyncedAt > FRESH_FOR_AGENT) &&
        (timers.get(account.accountId)?.retryAt ?? 0) <= now,
    );
    const runs = yield* Effect.forEach(stale, (account) => startSync(account.accountId, true));
    yield* Effect.forEach(runs, (run) => Deferred.await(run), { discard: true }).pipe(
      Effect.timeoutOption(AGENT_SYNC_WAIT),
    );
  }).pipe(Effect.ignoreCause({ log: true }));

  /** Starts every sync that is due, then sleeps until the next one or a wake-up. */
  const schedule = Effect.gen(function* () {
    yield* options.beforeAutoSync ?? Effect.void;
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      const accounts = yield* store.listAccounts.pipe(Effect.orElseSucceed(() => []));
      let next = now + IDLE_SYNC_INTERVAL;
      for (const account of accounts) {
        if (account.status === "signed_out" || running.has(account.accountId)) continue;
        const timer = timers.get(account.accountId);
        const interval = subscribers > 0 ? ACTIVE_SYNC_INTERVAL : IDLE_SYNC_INTERVAL;
        const last = timer?.lastAttempt || account.lastSyncedAt || 0;
        const due = Math.max(last + interval, timer?.retryAt ?? 0);
        if (due <= now) yield* startSync(account.accountId, false);
        else next = Math.min(next, due);
      }
      const jitter = 0.9 + (yield* Random.next) * 0.2;
      yield* Effect.raceFirst(
        Queue.take(wakeups),
        Effect.sleep(Duration.millis(Math.max(1000, (next - now) * jitter))),
      );
    }
  });

  // ── Search and free time ─────────────────────────────────────────

  const search: CalendarServiceShape["search"] = (input) =>
    Effect.gen(function* () {
      const limit = input.limit ?? 50;
      const now = yield* Clock.currentTimeMillis;
      const hits = yield* store.searchEvents(input.query.trim(), 500);
      // A single event is its own instance, so its times come with the hit; a series needs
      // its next (or last) occurrence.
      type Candidate = {
        readonly start: number;
        readonly end: number;
        readonly row?: InstanceRow;
        readonly single?: { readonly calendarId: string; readonly eventId: string };
      };
      const candidates: Array<Candidate> = [];
      const groups = new Map<
        string,
        { calendarId: string; key: string; whole: boolean; ids: Set<string> }
      >();
      for (const hit of hits) {
        if (hit.kind === "single") {
          if (hit.start !== null && hit.end !== null) {
            candidates.push({ start: hit.start, end: hit.end, single: hit });
          }
          continue;
        }
        const key = hit.seriesId ?? hit.eventId;
        const groupKey = `${hit.calendarId}/${key}`;
        let group = groups.get(groupKey);
        if (group === undefined) {
          group = { calendarId: hit.calendarId, key, whole: false, ids: new Set() };
          groups.set(groupKey, group);
        }
        if (hit.kind === "exception") group.ids.add(hit.eventId);
        else group.whole = true;
      }
      for (const group of groups.values()) {
        const row = yield* store.representativeInstance(
          group.calendarId,
          group.key,
          now,
          group.whole ? null : [...group.ids],
        );
        if (row !== undefined) candidates.push({ start: row.start, end: row.end, row });
      }
      const upcoming = candidates
        .filter((entry) => entry.end > now)
        .sort((a, b) => a.start - b.start);
      const past = candidates.filter((entry) => entry.end <= now).sort((a, b) => b.start - a.start);
      const chosen = [...upcoming, ...past].slice(0, limit);
      const singlesByCalendar = new Map<string, Array<string>>();
      for (const entry of chosen) {
        if (entry.single === undefined) continue;
        const ids = singlesByCalendar.get(entry.single.calendarId) ?? [];
        ids.push(entry.single.eventId);
        singlesByCalendar.set(entry.single.calendarId, ids);
      }
      const singleRows = new Map<string, InstanceRow>();
      for (const [calendarId, ids] of singlesByCalendar) {
        for (const row of yield* store.instancesById(calendarId, ids)) {
          singleRows.set(instanceKey(row), row);
        }
      }
      const results: Array<CalendarEventInstance> = [];
      for (const entry of chosen) {
        const row =
          entry.row ??
          (entry.single
            ? singleRows.get(`${entry.single.calendarId}/${entry.single.eventId}`)
            : undefined);
        if (row !== undefined) results.push(toInstance(row));
      }
      return { results };
    }).pipe(failedTo("search the calendars"));

  const findFreeTime: CalendarServiceShape["findFreeTime"] = (input) =>
    Effect.gen(function* () {
      if (!(input.end > input.start))
        return yield* invalid("The range has to end after it starts.");
      if (input.end - input.start > MAX_FREE_TIME_RANGE) {
        return yield* invalid("Look for free time in at most two months at once.");
      }
      if (!(input.durationMinutes > 0)) return yield* invalid("The duration has to be positive.");
      yield* ensureHorizon(input.start, input.end);
      const calendarIds = input.calendarIds ?? (yield* store.visibleCalendarIds);
      const rows = yield* store.rangeInstances(calendarIds, input.start, input.end);
      const range = { start: input.start, end: input.end };
      const zone = zoneOr(input.timeZone, serverZone);
      const windows =
        input.workingHoursOnly === false
          ? [range]
          : workingWindows(range, preferences.workingHours, zone);
      return freeSlots(
        windows,
        mergeBusy(rows, range),
        input.durationMinutes * MINUTE,
        FREE_SLOT_LIMIT,
      );
    }).pipe(failedTo("find free time"));

  // ── Startup ──────────────────────────────────────────────────────

  const demoSetting = yield* Config.String("T3CODE_CALENDAR_DEMO").pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  if (Option.isSome(demoSetting)) {
    const setting = parseDemoSetting(demoSetting.value);
    if (setting === null) {
      yield* Effect.logWarning(
        "Ignoring T3CODE_CALENDAR_DEMO: use standard, massive or <profile>:<seed>.",
      );
    } else if ((yield* store.listAccounts.pipe(Effect.orDie)).length === 0) {
      yield* addDemo({ size: setting.profile, seed: setting.seed }).pipe(
        Effect.ignoreCause({ log: true }),
      );
    }
  }

  if (options.autoSync !== false) {
    yield* schedule.pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(layerScope));
  }

  return CalendarService.of({
    directory,
    getDirectory,
    week,
    listInstances,
    getEvent,
    search,
    createEvent,
    updateEvent,
    deleteEvent,
    respond,
    restoreEvent,
    applyChanges,
    updateCalendar,
    updatePreferences,
    sync,
    ensureFresh,
    removeAccount: (accountId) => removeAccount(accountId),
    addDemo,
    connect,
    connectComplete: (input) => googleAuth.completeConnect(input),
    setClient: (input) => googleAuth.setClient(input),
    clearClient: googleAuth.clearClient,
    findFreeTime,
  });
});

function sendUpdatesOf(sendUpdates: "all" | "externalOnly" | "none" | undefined) {
  return sendUpdates === undefined ? {} : { sendUpdates };
}

export const layerWith = (options: CalendarServiceOptions) =>
  Layer.effect(CalendarService, make(options));

export const layer = layerWith({});
