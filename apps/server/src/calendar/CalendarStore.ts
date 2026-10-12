/**
 * CalendarStore - the calendar's SQLite access: rows in, records out. No locking or publishing;
 * `CalendarServiceLive` serializes writes and publishes after they commit.
 *
 * Hot paths (week ranges, bulk inserts during a sync) use batched statements with positional
 * values, so a week of a few thousand instances is one indexed scan per calendar and never
 * parses JSON.
 *
 * @module CalendarStore
 */
import type {
  CalendarAccessRole,
  CalendarAccountStatus,
  CalendarPreferences,
  CalendarProviderKind,
} from "@t3tools/contracts";
import { recurrenceEnd } from "@t3tools/shared/calendar/recurrence";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  WEEK_MS,
  eventKind,
  eventTimes,
  originalStartOf,
  updatedMs,
  type EventKind,
  type InstanceRow,
} from "./eventModel.ts";
import { recurrenceSeriesOf } from "./materialize.ts";
import type { RemoteEvent } from "./providers/CalendarProvider.ts";

export interface AccountRecord {
  readonly accountId: string;
  readonly provider: CalendarProviderKind;
  readonly externalId: string;
  readonly email: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly status: CalendarAccountStatus;
  readonly error: string | null;
  readonly lastSyncedAt: number | null;
  readonly position: number;
  readonly calendarListSyncToken: string | null;
  readonly demoProfile: string | null;
  readonly demoSeed: number | null;
  readonly demoIndex: number | null;
}

export interface CalendarRecord {
  readonly calendarId: string;
  readonly accountId: string;
  readonly remoteId: string;
  readonly name: string;
  readonly description: string | null;
  readonly color: string;
  readonly colorLocal: boolean;
  readonly accessRole: CalendarAccessRole;
  readonly primary: boolean;
  readonly visible: boolean;
  readonly timeZone: string | null;
  readonly position: number;
  readonly syncToken: string | null;
  readonly syncedAt: number | null;
  readonly horizonStart: number;
  readonly horizonEnd: number;
}

export interface StoredEvent {
  readonly calendarId: string;
  readonly eventId: string;
  readonly kind: EventKind;
  readonly seriesId: string | null;
  readonly status: string;
  readonly updatedMs: number | null;
  readonly event: RemoteEvent;
}

export interface SearchHit {
  readonly calendarId: string;
  readonly eventId: string;
  readonly seriesId: string | null;
  readonly kind: EventKind;
  readonly start: number | null;
  readonly end: number | null;
}

type Row = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === "string" ? value : String(value ?? ""));
const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number => Number(value ?? 0);
const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const accountOf = (row: Row): AccountRecord => ({
  accountId: text(row.account_id),
  provider: text(row.provider) as CalendarProviderKind,
  externalId: text(row.external_id),
  email: text(row.email),
  displayName: text(row.display_name),
  avatarUrl: textOrNull(row.avatar_url),
  status: text(row.status) as CalendarAccountStatus,
  error: textOrNull(row.error),
  lastSyncedAt: numOrNull(row.last_synced_at),
  position: num(row.position),
  calendarListSyncToken: textOrNull(row.calendar_list_sync_token),
  demoProfile: textOrNull(row.demo_profile),
  demoSeed: numOrNull(row.demo_seed),
  demoIndex: numOrNull(row.demo_index),
});

const calendarOf = (row: Row): CalendarRecord => ({
  calendarId: text(row.calendar_id),
  accountId: text(row.account_id),
  remoteId: text(row.remote_id),
  name: text(row.name),
  description: textOrNull(row.description),
  color: text(row.color),
  colorLocal: num(row.color_local) === 1,
  accessRole: text(row.access_role) as CalendarAccessRole,
  primary: num(row.is_primary) === 1,
  visible: num(row.visible) === 1,
  timeZone: textOrNull(row.time_zone),
  position: num(row.position),
  syncToken: textOrNull(row.sync_token),
  syncedAt: numOrNull(row.synced_at),
  horizonStart: num(row.horizon_start),
  horizonEnd: num(row.horizon_end),
});

const storedEventOf = (row: Row): StoredEvent => ({
  calendarId: text(row.calendar_id),
  eventId: text(row.event_id),
  kind: text(row.kind) as EventKind,
  seriesId: textOrNull(row.series_id),
  status: text(row.status),
  updatedMs: numOrNull(row.updated_ms),
  event: JSON.parse(text(row.json)) as RemoteEvent,
});

const INSTANCE_COLUMNS =
  "calendar_id, instance_id, source_key, series_id, start_ms, end_ms, flags, title, response, color, location";

/** Positional values in `INSTANCE_COLUMNS` order, as `.values` returns them. */
const instanceOfValues = (values: ReadonlyArray<unknown>): InstanceRow => ({
  calendarId: values[0] as string,
  instanceId: values[1] as string,
  sourceKey: values[2] as string,
  seriesId: (values[3] as string | null) ?? null,
  start: Number(values[4]),
  end: Number(values[5]),
  flags: Number(values[6]),
  title: values[7] as string,
  response: (values[8] as string | null) ?? null,
  color: (values[9] as string | null) ?? null,
  location: (values[10] as string | null) ?? null,
});

const EVENT_BATCH = 150;
const INSTANCE_BATCH = 250;

function placeholders(columns: number, rows: number): string {
  const row = `(${Array.from({ length: columns }, () => "?").join(",")})`;
  return Array.from({ length: rows }, () => row).join(",");
}

function chunks<A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> {
  const result: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

/** The indexed columns of an event, next to its JSON. */
function eventColumns(calendarId: string, event: RemoteEvent, zone: string): Array<unknown> {
  const kind = eventKind(event);
  const times = eventTimes(event, zone);
  let recurrenceEndMs: number | null = null;
  if (kind === "master" && times !== null) {
    recurrenceEndMs = recurrenceEnd(recurrenceSeriesOf(event, times));
  }
  return [
    calendarId,
    event.id,
    event.recurringEventId ?? null,
    kind,
    event.status ?? "confirmed",
    times?.start ?? null,
    times?.end ?? null,
    originalStartOf(event, times?.timeZone ?? zone),
    recurrenceEndMs,
    updatedMs(event),
    event.summary ?? "",
    event.location ?? "",
    event.description ?? "",
    JSON.stringify(event),
  ];
}

export function makeCalendarStore(sql: SqlClient.SqlClient) {
  // ── Accounts ─────────────────────────────────────────────────────

  const listAccounts = sql`SELECT * FROM calendar_accounts ORDER BY position, created_at`.pipe(
    Effect.map((rows) => rows.map(accountOf)),
  );

  const getAccount = (accountId: string) =>
    sql`SELECT * FROM calendar_accounts WHERE account_id = ${accountId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : accountOf(rows[0]))),
    );

  const findAccount = (provider: string, externalId: string) =>
    sql`SELECT * FROM calendar_accounts WHERE provider = ${provider} AND external_id = ${externalId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : accountOf(rows[0]))),
    );

  const insertAccount = (account: AccountRecord, createdAt: number) =>
    sql`
      INSERT INTO calendar_accounts (
        account_id, provider, external_id, email, display_name, avatar_url, status, error,
        last_synced_at, position, calendar_list_sync_token, demo_profile, demo_seed, demo_index,
        created_at
      ) VALUES (
        ${account.accountId}, ${account.provider}, ${account.externalId}, ${account.email},
        ${account.displayName}, ${account.avatarUrl}, ${account.status}, ${account.error},
        ${account.lastSyncedAt}, ${account.position}, ${account.calendarListSyncToken},
        ${account.demoProfile}, ${account.demoSeed}, ${account.demoIndex}, ${createdAt}
      )
    `.pipe(Effect.asVoid);

  const updateAccountProfile = (
    accountId: string,
    profile: {
      readonly email: string;
      readonly displayName: string;
      readonly avatarUrl: string | null;
    },
  ) =>
    sql`
      UPDATE calendar_accounts
      SET email = ${profile.email}, display_name = ${profile.displayName}, avatar_url = ${profile.avatarUrl}
      WHERE account_id = ${accountId}
    `.pipe(Effect.asVoid);

  const setAccountStatus = (
    accountId: string,
    status: CalendarAccountStatus,
    error: string | null,
    lastSyncedAt?: number,
  ) =>
    lastSyncedAt === undefined
      ? sql`UPDATE calendar_accounts SET status = ${status}, error = ${error} WHERE account_id = ${accountId}`.pipe(
          Effect.asVoid,
        )
      : sql`
          UPDATE calendar_accounts SET status = ${status}, error = ${error}, last_synced_at = ${lastSyncedAt}
          WHERE account_id = ${accountId}
        `.pipe(Effect.asVoid);

  const setCalendarListSyncToken = (accountId: string, token: string | null) =>
    sql`UPDATE calendar_accounts SET calendar_list_sync_token = ${token} WHERE account_id = ${accountId}`.pipe(
      Effect.asVoid,
    );

  const nextAccountPosition =
    sql`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM calendar_accounts`.pipe(
      Effect.map((rows) => num(rows[0]?.next)),
    );

  const deleteAccount = (accountId: string) =>
    sql`DELETE FROM calendar_accounts WHERE account_id = ${accountId}`.pipe(Effect.asVoid);

  // ── Calendars ────────────────────────────────────────────────────

  const listCalendars = sql`
    SELECT c.* FROM calendar_calendars c
    JOIN calendar_accounts a ON a.account_id = c.account_id
    ORDER BY a.position, c.is_primary DESC, c.position, c.name
  `.pipe(Effect.map((rows) => rows.map(calendarOf)));

  const calendarsOf = (accountId: string) =>
    sql`SELECT * FROM calendar_calendars WHERE account_id = ${accountId} ORDER BY position`.pipe(
      Effect.map((rows) => rows.map(calendarOf)),
    );

  const getCalendar = (calendarId: string) =>
    sql`SELECT * FROM calendar_calendars WHERE calendar_id = ${calendarId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : calendarOf(rows[0]))),
    );

  const visibleCalendarIds = sql`SELECT calendar_id FROM calendar_calendars WHERE visible = 1`.pipe(
    Effect.map((rows) => rows.map((row) => text(row.calendar_id))),
  );

  const insertCalendar = (calendar: CalendarRecord) =>
    sql`
      INSERT INTO calendar_calendars (
        calendar_id, account_id, remote_id, name, description, color, color_local, access_role,
        is_primary, visible, time_zone, position, sync_token, synced_at, horizon_start, horizon_end
      ) VALUES (
        ${calendar.calendarId}, ${calendar.accountId}, ${calendar.remoteId}, ${calendar.name},
        ${calendar.description}, ${calendar.color}, ${calendar.colorLocal ? 1 : 0},
        ${calendar.accessRole}, ${calendar.primary ? 1 : 0}, ${calendar.visible ? 1 : 0},
        ${calendar.timeZone}, ${calendar.position}, ${calendar.syncToken}, ${calendar.syncedAt},
        ${calendar.horizonStart}, ${calendar.horizonEnd}
      )
    `.pipe(Effect.asVoid);

  /** Google's view of a calendar; the local color survives once the user picked one. */
  const updateCalendarFromRemote = (
    calendarId: string,
    remote: {
      readonly name: string;
      readonly description: string | null;
      readonly color: string;
      readonly accessRole: CalendarAccessRole;
      readonly primary: boolean;
      readonly timeZone: string | null;
    },
  ) =>
    sql`
      UPDATE calendar_calendars SET
        name = ${remote.name},
        description = ${remote.description},
        color = CASE WHEN color_local = 1 THEN color ELSE ${remote.color} END,
        access_role = ${remote.accessRole},
        is_primary = ${remote.primary ? 1 : 0},
        time_zone = ${remote.timeZone}
      WHERE calendar_id = ${calendarId}
    `.pipe(Effect.asVoid);

  const setCalendarVisible = (calendarId: string, visible: boolean) =>
    sql`UPDATE calendar_calendars SET visible = ${visible ? 1 : 0} WHERE calendar_id = ${calendarId}`.pipe(
      Effect.asVoid,
    );

  const setCalendarColor = (calendarId: string, color: string) =>
    sql`UPDATE calendar_calendars SET color = ${color}, color_local = 1 WHERE calendar_id = ${calendarId}`.pipe(
      Effect.asVoid,
    );

  const setCalendarSync = (calendarId: string, syncToken: string | null, syncedAt: number | null) =>
    sql`
      UPDATE calendar_calendars SET sync_token = ${syncToken}, synced_at = ${syncedAt}
      WHERE calendar_id = ${calendarId}
    `.pipe(Effect.asVoid);

  const setHorizon = (calendarId: string, start: number, end: number) =>
    sql`
      UPDATE calendar_calendars SET horizon_start = ${start}, horizon_end = ${end}
      WHERE calendar_id = ${calendarId}
    `.pipe(Effect.asVoid);

  const deleteCalendar = (calendarId: string) =>
    sql`DELETE FROM calendar_calendars WHERE calendar_id = ${calendarId}`.pipe(Effect.asVoid);

  // ── Events ───────────────────────────────────────────────────────

  const getEvent = (calendarId: string, eventId: string) =>
    sql`SELECT * FROM calendar_events WHERE calendar_id = ${calendarId} AND event_id = ${eventId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : storedEventOf(rows[0]))),
    );

  /** A series: the event stored under `key` and every event naming it as its series. */
  const seriesEvents = (calendarId: string, key: string) =>
    sql`
      SELECT * FROM calendar_events
      WHERE calendar_id = ${calendarId} AND (event_id = ${key} OR series_id = ${key})
    `.pipe(
      Effect.map((rows) => {
        const events = rows.map(storedEventOf);
        return {
          master: events.find((event) => event.eventId === key && event.kind !== "exception"),
          exceptions: events.filter((event) => event.seriesId === key),
        };
      }),
    );

  const upsertEvents = (
    calendarId: string,
    events: ReadonlyArray<RemoteEvent>,
    zone: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.forEach(
      chunks(events, EVENT_BATCH),
      (batch) =>
        sql
          .unsafe(
            `INSERT INTO calendar_events (
              calendar_id, event_id, series_id, kind, status, start_ms, end_ms, original_start_ms,
              recurrence_end_ms, updated_ms, title, location, description, json
            ) VALUES ${placeholders(14, batch.length)}
            ON CONFLICT (calendar_id, event_id) DO UPDATE SET
              series_id = excluded.series_id, kind = excluded.kind, status = excluded.status,
              start_ms = excluded.start_ms, end_ms = excluded.end_ms,
              original_start_ms = excluded.original_start_ms,
              recurrence_end_ms = excluded.recurrence_end_ms, updated_ms = excluded.updated_ms,
              title = excluded.title, location = excluded.location,
              description = excluded.description, json = excluded.json`,
            batch.flatMap((event) => eventColumns(calendarId, event, zone)),
          )
          .raw.pipe(Effect.asVoid),
      { discard: true },
    );

  const deleteEvents = (calendarId: string, eventIds: ReadonlyArray<string>) =>
    Effect.forEach(
      chunks(eventIds, 500),
      (batch) =>
        sql`DELETE FROM calendar_events WHERE calendar_id = ${calendarId} AND ${sql.in("event_id", batch)}`,
      { discard: true },
    );

  /** Drops a calendar's events and instances (a full resync replaces them). */
  const clearCalendar = (calendarId: string) =>
    Effect.all(
      [
        sql`DELETE FROM calendar_instances WHERE calendar_id = ${calendarId}`,
        sql`DELETE FROM calendar_events WHERE calendar_id = ${calendarId}`,
      ],
      { discard: true },
    );

  /** Series keys of the calendar's masters whose recurrence reaches past `from`. */
  const masterKeysReaching = (calendarId: string, from: number, to: number) =>
    sql`
      SELECT event_id FROM calendar_events
      WHERE calendar_id = ${calendarId} AND kind = 'master' AND status != 'cancelled'
        AND (recurrence_end_ms IS NULL OR recurrence_end_ms > ${from})
        AND start_ms < ${to}
    `.pipe(Effect.map((rows) => rows.map((row) => text(row.event_id))));

  /** Every series key of a calendar: masters and singles by id, exceptions by their series. */
  const allSeriesKeys = (calendarId: string) =>
    sql`
      SELECT DISTINCT COALESCE(series_id, event_id) AS key FROM calendar_events
      WHERE calendar_id = ${calendarId}
    `.pipe(Effect.map((rows) => rows.map((row) => text(row.key))));

  /** All events of a calendar grouped by series key (for a full rematerialization). */
  const eventsBySeries = (calendarId: string) =>
    sql`SELECT * FROM calendar_events WHERE calendar_id = ${calendarId}`.pipe(
      Effect.map((rows) => {
        const groups = new Map<string, { master?: StoredEvent; exceptions: Array<StoredEvent> }>();
        for (const row of rows) {
          const stored = storedEventOf(row);
          const key = stored.seriesId ?? stored.eventId;
          let group = groups.get(key);
          if (group === undefined) {
            group = { exceptions: [] };
            groups.set(key, group);
          }
          if (stored.seriesId !== null) group.exceptions.push(stored);
          else group.master = stored;
        }
        return groups;
      }),
    );

  // ── Instances ────────────────────────────────────────────────────

  const instancesOfSource = (calendarId: string, key: string) =>
    sql
      .unsafe(
        `SELECT ${INSTANCE_COLUMNS} FROM calendar_instances WHERE calendar_id = ? AND source_key = ?`,
        [calendarId, key],
      )
      .values.pipe(Effect.map((rows) => rows.map(instanceOfValues)));

  const upsertInstances = (rows: ReadonlyArray<InstanceRow>): Effect.Effect<void, SqlError> =>
    Effect.forEach(
      chunks(rows, INSTANCE_BATCH),
      (batch) =>
        sql
          .unsafe(
            `INSERT INTO calendar_instances (
              calendar_id, instance_id, source_key, series_id, start_ms, end_ms, long, flags, title,
              response, color, location
            ) VALUES ${placeholders(12, batch.length)}
            ON CONFLICT (calendar_id, instance_id) DO UPDATE SET
              source_key = excluded.source_key, series_id = excluded.series_id,
              start_ms = excluded.start_ms, end_ms = excluded.end_ms, long = excluded.long,
              flags = excluded.flags, title = excluded.title, response = excluded.response,
              color = excluded.color, location = excluded.location`,
            batch.flatMap((row) => [
              row.calendarId,
              row.instanceId,
              row.sourceKey,
              row.seriesId,
              row.start,
              row.end,
              row.end - row.start > WEEK_MS ? 1 : 0,
              row.flags,
              row.title,
              row.response,
              row.color,
              row.location,
            ]),
          )
          .raw.pipe(Effect.asVoid),
      { discard: true },
    );

  const deleteInstances = (calendarId: string, instanceIds: ReadonlyArray<string>) =>
    Effect.forEach(
      chunks(instanceIds, 500),
      (batch) =>
        sql`DELETE FROM calendar_instances WHERE calendar_id = ${calendarId} AND ${sql.in("instance_id", batch)}`,
      { discard: true },
    );

  /**
   * Instances of the given calendars overlapping [from, to) (zero-length ones starting in it),
   * in start order. Short instances (a week or less) use the start index: they start in
   * [from - 7 days, to).
   */
  const rangeInstances = (calendarIds: ReadonlyArray<string>, from: number, to: number) => {
    if (calendarIds.length === 0) return Effect.succeed([] as Array<InstanceRow>);
    const marks = calendarIds.map(() => "?").join(",");
    return sql
      .unsafe(
        `SELECT ${INSTANCE_COLUMNS} FROM calendar_instances
         WHERE calendar_id IN (${marks}) AND long = 0 AND start_ms >= ? AND start_ms < ?
           AND (end_ms > ? OR start_ms >= ?)
         UNION ALL
         SELECT ${INSTANCE_COLUMNS} FROM calendar_instances
         WHERE calendar_id IN (${marks}) AND long = 1 AND start_ms < ? AND end_ms > ?`,
        [...calendarIds, from - WEEK_MS, to, from, from, ...calendarIds, to, from],
      )
      .values.pipe(
        Effect.map((rows) => rows.map(instanceOfValues).sort((a, b) => a.start - b.start)),
      );
  };

  /** The instance to show for a search hit: the next one from `now`, else the last one. */
  const representativeInstance = (
    calendarId: string,
    key: string,
    now: number,
    instanceIds: ReadonlyArray<string> | null,
  ) => {
    const only =
      instanceIds === null ? "" : ` AND instance_id IN (${instanceIds.map(() => "?").join(",")})`;
    const params = [calendarId, key, ...(instanceIds ?? [])];
    return sql
      .unsafe(
        `SELECT ${INSTANCE_COLUMNS} FROM calendar_instances
         WHERE calendar_id = ? AND source_key = ?${only} AND end_ms > ? ORDER BY start_ms LIMIT 1`,
        [...params, now],
      )
      .values.pipe(
        Effect.flatMap((rows) =>
          rows[0] !== undefined
            ? Effect.succeed(instanceOfValues(rows[0]))
            : sql
                .unsafe(
                  `SELECT ${INSTANCE_COLUMNS} FROM calendar_instances
                   WHERE calendar_id = ? AND source_key = ?${only} ORDER BY start_ms DESC LIMIT 1`,
                  params,
                )
                .values.pipe(
                  Effect.map((last) =>
                    last[0] === undefined ? undefined : instanceOfValues(last[0]),
                  ),
                ),
        ),
      );
  };

  /** Instances of one calendar by id. */
  const instancesById = (calendarId: string, instanceIds: ReadonlyArray<string>) =>
    instanceIds.length === 0
      ? Effect.succeed([] as Array<InstanceRow>)
      : sql
          .unsafe(
            `SELECT ${INSTANCE_COLUMNS} FROM calendar_instances
             WHERE calendar_id = ? AND instance_id IN (${instanceIds.map(() => "?").join(",")})`,
            [calendarId, ...instanceIds],
          )
          .values.pipe(Effect.map((rows) => rows.map(instanceOfValues)));

  // ── Search ───────────────────────────────────────────────────────

  const searchEvents = (query: string, limit: number) => {
    const hitOf = (row: Row): SearchHit => ({
      calendarId: text(row.calendar_id),
      eventId: text(row.event_id),
      seriesId: textOrNull(row.series_id),
      kind: text(row.kind) as EventKind,
      start: numOrNull(row.start_ms),
      end: numOrNull(row.end_ms),
    });
    if ([...query].length >= 3) {
      const phrase = `"${query.replace(/"/g, '""')}"`;
      return sql`
        SELECT e.calendar_id, e.event_id, e.series_id, e.kind, e.start_ms, e.end_ms
        FROM calendar_event_search s JOIN calendar_events e ON e.rowid = s.rowid
        WHERE calendar_event_search MATCH ${phrase}
        LIMIT ${limit}
      `.pipe(Effect.map((rows) => rows.map(hitOf)));
    }
    const pattern = `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    return sql`
      SELECT calendar_id, event_id, series_id, kind, start_ms, end_ms FROM calendar_events
      WHERE status != 'cancelled' AND (
        title LIKE ${pattern} ESCAPE '\\' OR location LIKE ${pattern} ESCAPE '\\'
        OR description LIKE ${pattern} ESCAPE '\\'
      )
      LIMIT ${limit}
    `.pipe(Effect.map((rows) => rows.map(hitOf)));
  };

  // ── Preferences ──────────────────────────────────────────────────

  const readPreferences = sql`SELECT key, value_json FROM calendar_preferences`.pipe(
    Effect.map((rows) => {
      const values: Record<string, unknown> = {};
      for (const row of rows) values[text(row.key)] = JSON.parse(text(row.value_json));
      return values as Partial<CalendarPreferences>;
    }),
  );

  const writePreferences = (entries: ReadonlyArray<readonly [string, unknown]>) =>
    Effect.forEach(
      entries,
      ([key, value]) =>
        sql`
          INSERT INTO calendar_preferences (key, value_json) VALUES (${key}, ${JSON.stringify(value)})
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json
        `,
      { discard: true },
    );

  return {
    listAccounts,
    getAccount,
    findAccount,
    insertAccount,
    updateAccountProfile,
    setAccountStatus,
    setCalendarListSyncToken,
    nextAccountPosition,
    deleteAccount,
    listCalendars,
    calendarsOf,
    getCalendar,
    visibleCalendarIds,
    insertCalendar,
    updateCalendarFromRemote,
    setCalendarVisible,
    setCalendarColor,
    setCalendarSync,
    setHorizon,
    deleteCalendar,
    getEvent,
    seriesEvents,
    upsertEvents,
    deleteEvents,
    clearCalendar,
    masterKeysReaching,
    allSeriesKeys,
    eventsBySeries,
    instancesOfSource,
    upsertInstances,
    deleteInstances,
    rangeInstances,
    representativeInstance,
    instancesById,
    searchEvents,
    readPreferences,
    writePreferences,
  };
}

export type CalendarStore = ReturnType<typeof makeCalendarStore>;
