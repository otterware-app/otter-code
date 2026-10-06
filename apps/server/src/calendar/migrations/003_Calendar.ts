import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Otter Calendar: accounts, their calendars, the events synced from Google (singles, recurring
 * masters and exceptions, as Google returns them), and the occurrences materialized from them.
 *
 * `calendar_instances` is what week views read: one row per occurrence with the display columns,
 * so a week is an indexed range scan that never parses JSON. Instances longer than a week are
 * flagged `long` so short ones can bound their start: a short instance overlapping [from, to)
 * starts in [from - 7 days, to).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE calendar_accounts (
      account_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      status TEXT NOT NULL,
      error TEXT,
      last_synced_at INTEGER,
      position INTEGER NOT NULL,
      calendar_list_sync_token TEXT,
      demo_profile TEXT,
      demo_seed INTEGER,
      demo_index INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (provider, external_id)
    )
  `;

  yield* sql`
    CREATE TABLE calendar_calendars (
      calendar_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES calendar_accounts(account_id) ON DELETE CASCADE,
      remote_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      color TEXT NOT NULL,
      color_local INTEGER NOT NULL DEFAULT 0,
      access_role TEXT NOT NULL,
      is_primary INTEGER NOT NULL,
      visible INTEGER NOT NULL,
      time_zone TEXT,
      position INTEGER NOT NULL,
      sync_token TEXT,
      synced_at INTEGER,
      horizon_start INTEGER NOT NULL,
      horizon_end INTEGER NOT NULL,
      UNIQUE (account_id, remote_id)
    )
  `;

  // `kind`: single, master (has recurrence) or exception (has series_id). `recurrence_end_ms`
  // is a master's last occurrence end, null while it repeats forever. `json` is the event as
  // Google returned it.
  yield* sql`
    CREATE TABLE calendar_events (
      calendar_id TEXT NOT NULL REFERENCES calendar_calendars(calendar_id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      series_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      start_ms INTEGER,
      end_ms INTEGER,
      original_start_ms INTEGER,
      recurrence_end_ms INTEGER,
      updated_ms INTEGER,
      title TEXT NOT NULL,
      location TEXT NOT NULL,
      description TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (calendar_id, event_id)
    )
  `;

  yield* sql`
    CREATE INDEX idx_calendar_events_series
    ON calendar_events(calendar_id, series_id) WHERE series_id IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX idx_calendar_events_masters
    ON calendar_events(calendar_id, recurrence_end_ms) WHERE kind = 'master'
  `;

  // Search over title, location and description of events that are not cancelled. Trigram
  // tokens make any substring of three or more characters an index lookup.
  yield* sql`
    CREATE VIRTUAL TABLE calendar_event_search
    USING fts5(title, location, description, tokenize = 'trigram')
  `;

  yield* sql`
    CREATE TRIGGER calendar_events_search_insert AFTER INSERT ON calendar_events
    WHEN new.status != 'cancelled'
    BEGIN
      INSERT INTO calendar_event_search(rowid, title, location, description)
      VALUES (new.rowid, new.title, new.location, new.description);
    END
  `;

  yield* sql`
    CREATE TRIGGER calendar_events_search_update AFTER UPDATE ON calendar_events
    BEGIN
      DELETE FROM calendar_event_search WHERE rowid = old.rowid;
      INSERT INTO calendar_event_search(rowid, title, location, description)
      SELECT new.rowid, new.title, new.location, new.description WHERE new.status != 'cancelled';
    END
  `;

  yield* sql`
    CREATE TRIGGER calendar_events_search_delete AFTER DELETE ON calendar_events
    BEGIN
      DELETE FROM calendar_event_search WHERE rowid = old.rowid;
    END
  `;

  // `source_key` is the series an instance was generated from (the master id), or the single
  // event's own id. `flags` packs all-day, tentative, free, video call and read-only.
  yield* sql`
    CREATE TABLE calendar_instances (
      calendar_id TEXT NOT NULL REFERENCES calendar_calendars(calendar_id) ON DELETE CASCADE,
      instance_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      series_id TEXT,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      long INTEGER NOT NULL,
      flags INTEGER NOT NULL,
      title TEXT NOT NULL,
      response TEXT,
      color TEXT,
      location TEXT,
      PRIMARY KEY (calendar_id, instance_id)
    )
  `;

  yield* sql`
    CREATE INDEX idx_calendar_instances_range
    ON calendar_instances(calendar_id, long, start_ms)
  `;

  yield* sql`
    CREATE INDEX idx_calendar_instances_source
    ON calendar_instances(calendar_id, source_key, start_ms)
  `;

  yield* sql`
    CREATE TABLE calendar_preferences (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    )
  `;
});
