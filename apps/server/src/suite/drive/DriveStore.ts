/**
 * The Drive module's tables in `suite.sqlite`: thread links, what the user
 * last looked at, and the documents shared with them. Written against a plain
 * `SqlClient`; the module provides `SuiteDatabase.layerSqlClient` locally.
 */
import {
  DriveDocumentSnapshot,
  type DriveLinkSyncState,
  type DriveThreadLink,
  type DriveThreadLinkSource,
} from "@t3tools/contracts/suite";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { SuiteMigration } from "../SuiteMigrations.ts";

export const DRIVE_MODULE_ID = "drive";

export const DRIVE_MIGRATIONS: ReadonlyArray<SuiteMigration> = [
  {
    module: DRIVE_MODULE_ID,
    id: 1,
    name: "drive_thread_links",
    run: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // `thread_id` is the thread's id on this server; links never leave it.
      yield* sql`
        CREATE TABLE drive_thread_links (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          artifact_id TEXT,
          url TEXT NOT NULL,
          folder_slug TEXT,
          slug TEXT,
          share_token TEXT,
          title TEXT,
          kind TEXT,
          version INTEGER,
          source TEXT NOT NULL,
          linked_at TEXT NOT NULL,
          snapshot_json TEXT,
          sync_state TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `;
      yield* sql`CREATE INDEX drive_thread_links_thread ON drive_thread_links (thread_id)`;
      yield* sql`CREATE INDEX drive_thread_links_artifact ON drive_thread_links (artifact_id)`;
      // The version of each document the user last saw; the baseline for "changed".
      yield* sql`
        CREATE TABLE drive_document_views (
          artifact_id TEXT PRIMARY KEY,
          viewed_version INTEGER,
          viewed_at TEXT NOT NULL
        )
      `;
      // Documents shared with the user, as the last sweep saw them.
      yield* sql`
        CREATE TABLE drive_shared_documents (
          artifact_id TEXT PRIMARY KEY,
          snapshot_json TEXT NOT NULL,
          url TEXT NOT NULL,
          shared_by TEXT,
          shared_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `;
    }),
  },
];

interface LinkRow {
  readonly id: string;
  readonly thread_id: string;
  readonly artifact_id: string | null;
  readonly url: string;
  readonly folder_slug: string | null;
  readonly slug: string | null;
  readonly share_token: string | null;
  readonly title: string | null;
  readonly kind: string | null;
  readonly version: number | null;
  readonly source: string;
  readonly linked_at: string;
  readonly snapshot_json: string | null;
  readonly sync_state: string;
  readonly updated_at: string;
}

/** A link as stored, before `changed` is worked out against the views. */
export interface StoredDriveLink {
  readonly id: string;
  readonly threadId: string;
  readonly artifactId: string | null;
  readonly url: string;
  readonly folderSlug: string | null;
  readonly slug: string | null;
  readonly shareToken: string | null;
  readonly version: number | null;
  readonly source: DriveThreadLinkSource;
  readonly linkedAt: string;
  readonly snapshot: DriveDocumentSnapshot | null;
  readonly syncState: DriveLinkSyncState;
}

export interface SharedDriveDocument {
  readonly artifactId: string;
  readonly snapshot: DriveDocumentSnapshot;
  readonly url: string;
  readonly sharedBy: string | null;
  readonly sharedAt: string;
}

const SnapshotJson = Schema.fromJsonString(DriveDocumentSnapshot);
const decodeSnapshot = Schema.decodeUnknownOption(SnapshotJson);
const encodeSnapshot = Schema.encodeSync(SnapshotJson);

const SYNC_STATES = new Set<string>([
  "pending",
  "synced",
  "not_connected",
  "not_found",
  "unavailable",
]);

function linkOfRow(row: LinkRow): StoredDriveLink {
  const snapshot = row.snapshot_json === null ? null : decodeSnapshot(row.snapshot_json);
  return {
    id: row.id,
    threadId: row.thread_id,
    artifactId: row.artifact_id,
    url: row.url,
    folderSlug: row.folder_slug,
    slug: row.slug,
    shareToken: row.share_token,
    version: row.version,
    source: row.source === "agent" ? "agent" : "manual",
    linkedAt: row.linked_at,
    snapshot: snapshot === null || snapshot._tag === "None" ? null : snapshot.value,
    syncState: (SYNC_STATES.has(row.sync_state) ? row.sync_state : "pending") as DriveLinkSyncState,
  };
}

/** The wire shape, with `changed` against the version last viewed. */
export function toDriveThreadLink(
  link: StoredDriveLink,
  viewedVersions: ReadonlyMap<string, number | null>,
): DriveThreadLink {
  const current = link.snapshot?.version ?? null;
  const viewed = link.artifactId === null ? undefined : viewedVersions.get(link.artifactId);
  return {
    id: link.id,
    threadId: ThreadId.make(link.threadId),
    artifactId: link.artifactId,
    url: link.url,
    folderSlug: link.folderSlug,
    slug: link.slug,
    version: link.version,
    source: link.source,
    linkedAt: link.linkedAt,
    snapshot: link.snapshot,
    syncState: link.syncState,
    changed: current !== null && viewed !== undefined && viewed !== null && current > viewed,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const makeDriveStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listLinks = sql<LinkRow>`
    SELECT * FROM drive_thread_links ORDER BY linked_at ASC, id ASC
  `.pipe(Effect.map((rows) => rows.map(linkOfRow)));

  const listThreadLinks = (threadId: string) =>
    sql<LinkRow>`
      SELECT * FROM drive_thread_links WHERE thread_id = ${threadId} ORDER BY linked_at ASC, id ASC
    `.pipe(Effect.map((rows) => rows.map(linkOfRow)));

  const insertLink = (link: StoredDriveLink, now: string) =>
    sql`
      INSERT INTO drive_thread_links (
        id, thread_id, artifact_id, url, folder_slug, slug, share_token, title, kind,
        version, source, linked_at, snapshot_json, sync_state, updated_at
      ) VALUES (
        ${link.id}, ${link.threadId}, ${link.artifactId}, ${link.url}, ${link.folderSlug},
        ${link.slug}, ${link.shareToken}, ${link.snapshot?.title ?? null},
        ${link.snapshot?.kind ?? null}, ${link.version}, ${link.source}, ${link.linkedAt},
        ${link.snapshot === null ? null : encodeSnapshot(link.snapshot)}, ${link.syncState}, ${now}
      )
    `.pipe(Effect.asVoid);

  const deleteLink = (threadId: string, linkId: string) =>
    sql<{ readonly id: string }>`
      DELETE FROM drive_thread_links WHERE thread_id = ${threadId} AND id = ${linkId} RETURNING id
    `.pipe(Effect.map((rows) => rows.length > 0));

  /**
   * Records a sync result; returns whether anything the client shows changed.
   * A failed read keeps the last snapshot, so a link stays readable offline.
   */
  const recordSync = (
    link: StoredDriveLink,
    update: {
      readonly artifactId: string | null;
      readonly url: string;
      readonly folderSlug: string | null;
      readonly slug: string | null;
      readonly snapshot: DriveDocumentSnapshot | null;
      readonly syncState: DriveLinkSyncState;
    },
    now: string,
  ) => {
    const snapshot = update.snapshot ?? link.snapshot;
    const comparable = (value: DriveDocumentSnapshot | null) =>
      value === null ? null : encodeSnapshot({ ...value, syncedAt: "" });
    const visibleChange =
      comparable(link.snapshot) !== comparable(snapshot) ||
      link.artifactId !== update.artifactId ||
      link.url !== update.url ||
      link.syncState !== update.syncState;
    return sql`
      UPDATE drive_thread_links SET
        artifact_id = ${update.artifactId},
        url = ${update.url},
        folder_slug = ${update.folderSlug},
        slug = ${update.slug},
        title = ${snapshot?.title ?? null},
        kind = ${snapshot?.kind ?? null},
        snapshot_json = ${snapshot === null ? null : encodeSnapshot(snapshot)},
        sync_state = ${update.syncState},
        updated_at = ${now}
      WHERE id = ${link.id}
    `.pipe(Effect.as(visibleChange));
  };

  const viewedVersions = sql<{
    readonly artifact_id: string;
    readonly viewed_version: number | null;
  }>`
    SELECT artifact_id, viewed_version FROM drive_document_views
  `.pipe(Effect.map((rows) => new Map(rows.map((row) => [row.artifact_id, row.viewed_version]))));

  /** Raises the viewed version (never lowers it). */
  const markViewed = (artifactId: string, version: number, now: string) =>
    sql`
      INSERT INTO drive_document_views (artifact_id, viewed_version, viewed_at)
      VALUES (${artifactId}, ${version}, ${now})
      ON CONFLICT (artifact_id) DO UPDATE SET
        viewed_version = max(coalesce(drive_document_views.viewed_version, 0), excluded.viewed_version),
        viewed_at = excluded.viewed_at
    `.pipe(Effect.asVoid);

  /** The first time a document is seen, its current version is the baseline: nothing is new yet. */
  const ensureBaseline = (artifactId: string, version: number | null, now: string) =>
    sql`
      INSERT INTO drive_document_views (artifact_id, viewed_version, viewed_at)
      VALUES (${artifactId}, ${version}, ${now})
      ON CONFLICT (artifact_id) DO NOTHING
    `.pipe(Effect.asVoid);

  const listShared = sql<{
    readonly artifact_id: string;
    readonly snapshot_json: string;
    readonly url: string;
    readonly shared_by: string | null;
    readonly shared_at: string;
  }>`SELECT * FROM drive_shared_documents`.pipe(
    Effect.map((rows) =>
      rows.flatMap((row): Array<SharedDriveDocument> => {
        const snapshot = decodeSnapshot(row.snapshot_json);
        return snapshot._tag === "None"
          ? []
          : [
              {
                artifactId: row.artifact_id,
                snapshot: snapshot.value,
                url: row.url,
                sharedBy: row.shared_by,
                sharedAt: row.shared_at,
              },
            ];
      }),
    ),
  );

  /** Replaces the shared list with what Drive reports now. */
  const replaceShared = (documents: ReadonlyArray<SharedDriveDocument>, now: string) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM drive_shared_documents`;
      for (const document of documents) {
        yield* sql`
          INSERT INTO drive_shared_documents (artifact_id, snapshot_json, url, shared_by, shared_at, updated_at)
          VALUES (${document.artifactId}, ${encodeSnapshot(document.snapshot)}, ${document.url},
            ${document.sharedBy}, ${document.sharedAt}, ${now})
          ON CONFLICT (artifact_id) DO NOTHING
        `;
      }
    }).pipe(sql.withTransaction);

  return {
    listLinks,
    listThreadLinks,
    insertLink,
    deleteLink,
    recordSync,
    viewedVersions,
    markViewed,
    ensureBaseline,
    listShared,
    replaceShared,
  };
});

export type DriveStore = Effect.Success<typeof makeDriveStore>;
