/**
 * The Drive module's one service: documents read through Drive's API, Drive
 * documents linked to Code threads, and the sync that keeps those links'
 * snapshots current (like `LinearIssueSyncReactor` does for Linear issues).
 * RPC handlers and MCP tools only decode, call a method here and map errors.
 */
import type { Artifact } from "@otterware/drive-contracts";
import {
  type DriveConnectionStatus,
  type DriveDocumentDetail,
  type DriveDocumentPreview,
  type DriveDocumentSummary,
  DriveError,
  type DriveFolder,
  type DriveListDocumentsInput,
  type DriveThreadLink,
  type DriveThreadLinkSource,
  type DriveUrlTarget,
  driveDocumentKind,
  isDriveArtifactId,
  isDriveTextKind,
  parseDriveUrl,
} from "@t3tools/contracts/suite";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { forkParked } from "../../serverActivation.ts";
import * as SuiteDatabase from "../SuiteDatabase.ts";
import { type DriveApi, type DriveApiError, makeDriveApi } from "./DriveApi.ts";
import {
  type DriveConnection,
  DriveBaseUrlConfig,
  driveErrorOf,
  driveNotConnected,
  makeDriveConnection,
} from "./DriveConnection.ts";
import {
  canonicalArtifactUrl,
  folderOf,
  matchesDocumentQuery,
  snapshotOfArtifact,
  summaryOfArtifact,
  versionOf,
} from "./driveDocuments.ts";
import {
  type DriveStore,
  type SharedDriveDocument,
  type StoredDriveLink,
  makeDriveStore,
  toDriveThreadLink,
} from "./DriveStore.ts";

/** Linked documents and the shared list are re-read on this cadence. */
const SYNC_INTERVAL = "3 minutes";
/** Text previews and agent reads stop here. */
export const DRIVE_PREVIEW_MAX_BYTES = 64 * 1024;
export const DRIVE_READ_MAX_BYTES = 256 * 1024;
const FOLDER_CACHE_MS = 60_000;

const CONTENT_TYPES = {
  markdown: { extension: "md", contentType: "text/markdown" },
  text: { extension: "txt", contentType: "text/plain" },
  csv: { extension: "csv", contentType: "text/csv" },
  tsv: { extension: "tsv", contentType: "text/tab-separated-values" },
} as const;
export type DriveTextFormat = keyof typeof CONTENT_TYPES;

export interface DriveHomeEntry {
  readonly artifactId: string;
  readonly title: string;
  readonly url: string;
  readonly folderId: string;
  readonly folderSlug: string;
  readonly version: number;
  readonly viewedVersion: number;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
  readonly threadIds: ReadonlyArray<string>;
  readonly shared: boolean;
}

export class DriveService extends Context.Service<
  DriveService,
  {
    readonly baseUrl: string;
    readonly status: Effect.Effect<DriveConnectionStatus>;
    readonly statusChanges: Stream.Stream<DriveConnectionStatus>;
    readonly connect: Effect.Effect<DriveConnectionStatus, DriveError>;
    readonly disconnect: Effect.Effect<DriveConnectionStatus>;
    readonly listFolders: Effect.Effect<ReadonlyArray<DriveFolder>, DriveError>;
    readonly listDocuments: (
      input: DriveListDocumentsInput,
    ) => Effect.Effect<ReadonlyArray<DriveDocumentSummary>, DriveError>;
    readonly documentDetail: (
      reference: string,
      version?: number,
    ) => Effect.Effect<DriveDocumentDetail, DriveError>;
    readonly readDocument: (
      reference: string,
      version?: number,
    ) => Effect.Effect<
      {
        readonly document: DriveDocumentSummary;
        readonly version: number;
        readonly text: string;
        readonly truncated: boolean;
      },
      DriveError
    >;
    readonly createDocument: (input: {
      readonly title: string;
      readonly slug: string;
      readonly format: DriveTextFormat;
      readonly content: string;
      readonly description?: string | undefined;
      readonly folderId?: string | undefined;
      readonly label?: string | undefined;
    }) => Effect.Effect<DriveDocumentSummary, DriveError>;
    readonly updateDocument: (input: {
      readonly reference: string;
      readonly content: string;
      readonly ifVersion: number;
      readonly label: string;
    }) => Effect.Effect<DriveDocumentSummary, DriveError>;
    readonly markViewed: (artifactId: string, version: number) => Effect.Effect<void, DriveError>;
    readonly linkDocument: (input: {
      readonly threadId: string;
      readonly reference: string;
      readonly source: DriveThreadLinkSource;
    }) => Effect.Effect<
      { readonly link: DriveThreadLink; readonly alreadyLinked: boolean },
      DriveError
    >;
    /** By link id, artifact id or URL. */
    readonly unlinkDocument: (
      threadId: string,
      reference: string,
    ) => Effect.Effect<{ readonly wasLinked: boolean }, DriveError>;
    readonly listThreadLinks: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<DriveThreadLink>, DriveError>;
    /** Every link, now and after each change. */
    readonly linkChanges: Stream.Stream<{ readonly links: ReadonlyArray<DriveThreadLink> }>;
    /** Linked or shared documents with a newer version than the user last saw. */
    readonly changedDocuments: Effect.Effect<ReadonlyArray<DriveHomeEntry>>;
    readonly requestSync: Effect.Effect<void>;
    /** One sweep, now; tests run it instead of waiting for the interval. */
    readonly syncNow: Effect.Effect<void>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/suite/drive/DriveService") {}

const storeFailure = () =>
  new DriveError({ reason: "unavailable", detail: "Otterware's Drive data could not be read." });

/** Drive's API failures to what clients and agents are told; module errors pass through. */
const asDriveError = (error: DriveApiError | DriveError): DriveError =>
  error._tag === "DriveApiError" ? driveErrorOf(error) : error;
const isRejected = (error: { readonly _tag: string }) =>
  error._tag === "DriveApiError" && (error as DriveApiError).status === 401;

/** @public Service construction is part of the canonical Effect module API. */
export const makeWith = (options: { readonly api: DriveApi; readonly store: DriveStore }) =>
  Effect.gen(function* () {
    const { api, store } = options;
    const baseUrl = api.origin;
    const crypto = yield* Crypto.Crypto;
    const connection: DriveConnection = yield* makeDriveConnection(api, baseUrl);
    const revision = yield* SubscriptionRef.make(0);
    let folderCache: {
      readonly token: string;
      readonly at: number;
      folders: Array<DriveFolder>;
    } | null = null;

    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const bump = SubscriptionRef.update(revision, (value) => value + 1);
    const orStoreFailure = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.mapError(storeFailure));

    /** Runs an API call with the session; a rejected token marks the connection signed out. */
    const withSession = <A>(
      run: (token: string) => Effect.Effect<A, DriveApiError>,
    ): Effect.Effect<A, DriveError> =>
      Effect.gen(function* () {
        const session = yield* connection.requireSession;
        return yield* run(session.token).pipe(
          Effect.tapError((error) =>
            error.status === 401 ? connection.markRejected : Effect.void,
          ),
          Effect.mapError(driveErrorOf),
        );
      });

    const folders = (token: string) =>
      Effect.gen(function* () {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        if (folderCache && folderCache.token === token && now - folderCache.at < FOLDER_CACHE_MS)
          return folderCache.folders;
        const listed = (yield* api.listFolders({ token })).map(folderOf);
        folderCache = { token, at: now, folders: listed };
        return listed;
      });

    /**
     * The document a URL or id names. Slugs resolve in the folder the URL
     * names; a document shared on its own is found among what is shared with
     * the user, like Drive's own document route. Share links are opened
     * (accepted) first, as following them in Drive would.
     */
    const resolveArtifact = (token: string, target: DriveUrlTarget | { readonly id: string }) =>
      Effect.gen(function* () {
        if ("id" in target) return yield* api.getArtifact(target.id, { token });
        if (target.type === "share-link") {
          const accepted = yield* api.acceptLink(target.token, { token });
          if (accepted.type !== "artifact" || accepted.slug === null)
            return yield* new DriveError({
              reason: "invalid_url",
              detail: "That link shares a folder. Link one of its documents instead.",
            });
          return yield* api.getArtifact(accepted.slug, { token, folderId: accepted.folderId });
        }
        if (target.type === "folder")
          return yield* new DriveError({
            reason: "invalid_url",
            detail: "That is a folder, not a document.",
          });
        if (target.folderSlug === null || isDriveArtifactId(target.reference))
          return yield* api.getArtifact(target.reference, { token });
        const folder = (yield* folders(token)).find((entry) => entry.slug === target.folderSlug);
        if (folder) return yield* api.getArtifact(target.reference, { token, folderId: folder.id });
        const shared = yield* api.sharedWithMe({ token });
        const match = shared.find(
          (item) =>
            item.artifact !== undefined &&
            item.folderSlug === target.folderSlug &&
            (item.artifact.slug === target.reference || item.artifact.id === target.reference),
        )?.artifact;
        if (match) return match;
        return yield* new DriveError({
          reason: "not_found",
          detail: "This document isn't in a folder you can open, or it was not shared with you.",
        });
      });

    const targetOf = (reference: string) => {
      if (isDriveArtifactId(reference)) return Effect.succeed({ id: reference } as const);
      const target = parseDriveUrl(reference, baseUrl);
      return target === null
        ? Effect.fail(
            new DriveError({
              reason: "invalid_url",
              detail: "Pass a Drive document id or a drive.otterware.app document or share link.",
            }),
          )
        : Effect.succeed(target);
    };

    const resolve = (reference: string) =>
      Effect.gen(function* () {
        const target = yield* targetOf(reference);
        const session = yield* connection.requireSession;
        return yield* resolveArtifact(session.token, target).pipe(
          Effect.tapError((error) => (isRejected(error) ? connection.markRejected : Effect.void)),
          Effect.mapError(asDriveError),
          Effect.map((artifact) => ({ artifact, token: session.token, target })),
        );
      });

    // ----- links -------------------------------------------------------------

    const viewedVersions = orStoreFailure(store.viewedVersions);

    const allLinks = Effect.gen(function* () {
      const [links, views] = yield* Effect.all([store.listLinks, store.viewedVersions]);
      return links.map((link) => toDriveThreadLink(link, views));
    });

    /** Writes a freshly read document onto every link that names it. */
    const recordArtifact = (links: ReadonlyArray<StoredDriveLink>, artifact: Artifact) =>
      Effect.gen(function* () {
        const now = yield* nowIso;
        const snapshot = snapshotOfArtifact(artifact, baseUrl, now);
        let changed = false;
        for (const link of links) {
          const updated = yield* store.recordSync(
            link,
            {
              artifactId: artifact.id,
              // A link to a pinned version keeps naming that version.
              url:
                link.version === null
                  ? canonicalArtifactUrl(artifact)
                  : `${canonicalArtifactUrl(artifact)}/v${link.version}`,
              folderSlug: snapshot.folderSlug,
              slug: artifact.slug,
              snapshot,
              syncState: "synced",
            },
            now,
          );
          changed = changed || updated;
        }
        yield* store.ensureBaseline(artifact.id, snapshot.version, now);
        return changed;
      });

    const recordFailure = (
      links: ReadonlyArray<StoredDriveLink>,
      syncState: "not_connected" | "not_found" | "unavailable",
    ) =>
      Effect.gen(function* () {
        const now = yield* nowIso;
        let changed = false;
        for (const link of links) {
          const updated = yield* store.recordSync(
            link,
            {
              artifactId: link.artifactId,
              url: link.url,
              folderSlug: link.folderSlug,
              slug: link.slug,
              snapshot: null,
              syncState,
            },
            now,
          );
          changed = changed || updated;
        }
        return changed;
      });

    const failureState = (error: DriveError) =>
      error.reason === "not_connected"
        ? ("not_connected" as const)
        : error.reason === "not_found" || error.reason === "forbidden"
          ? ("not_found" as const)
          : ("unavailable" as const);

    const linkTarget = (link: StoredDriveLink): DriveUrlTarget | { readonly id: string } | null =>
      link.artifactId !== null
        ? { id: link.artifactId }
        : link.shareToken !== null
          ? { type: "share-link", token: link.shareToken, url: link.url }
          : parseDriveUrl(link.url, baseUrl);

    /** Reads every linked document once (one read per document) and records the results. */
    const syncLinks = (links: ReadonlyArray<StoredDriveLink>) =>
      Effect.gen(function* () {
        const session = yield* connection.session;
        if (session === null) {
          const stale = links.filter((link) => link.syncState !== "not_connected");
          return stale.length > 0 ? yield* recordFailure(stale, "not_connected") : false;
        }
        const groups = new Map<string, Array<StoredDriveLink>>();
        for (const link of links) {
          const key = link.artifactId ?? link.url;
          groups.set(key, [...(groups.get(key) ?? []), link]);
        }
        let changed = false;
        for (const group of groups.values()) {
          const target = linkTarget(group[0]!);
          if (target === null) {
            changed = (yield* recordFailure(group, "not_found")) || changed;
            continue;
          }
          const result = yield* resolveArtifact(session.token, target).pipe(Effect.result);
          if (result._tag === "Success") {
            changed = (yield* recordArtifact(group, result.success)) || changed;
            continue;
          }
          const error = result.failure;
          if (isRejected(error)) yield* connection.markRejected;
          changed = (yield* recordFailure(group, failureState(asDriveError(error)))) || changed;
        }
        return changed;
      });

    /** The shared-with-me list, for Home's "changed since you looked". */
    const syncShared = Effect.gen(function* () {
      const session = yield* connection.session;
      if (session === null) return;
      const shared = yield* api.sharedWithMe({ token: session.token });
      const now = yield* nowIso;
      const documents: Array<SharedDriveDocument> = shared.flatMap((item) =>
        item.type === "artifact" && item.artifact
          ? [
              {
                artifactId: item.artifact.id,
                snapshot: snapshotOfArtifact(item.artifact, baseUrl, now),
                url: canonicalArtifactUrl(item.artifact),
                sharedBy: item.sharedBy?.name ?? item.sharedBy?.email ?? null,
                sharedAt: item.sharedAt,
              },
            ]
          : [],
      );
      yield* store.replaceShared(documents, now);
      for (const document of documents)
        yield* store.ensureBaseline(document.artifactId, document.snapshot.version, now);
    }).pipe(Effect.catch((error) => (isRejected(error) ? connection.markRejected : Effect.void)));

    const sweep = Effect.gen(function* () {
      const links = yield* store.listLinks;
      const changed = links.length === 0 ? false : yield* syncLinks(links);
      yield* syncShared;
      // Views can change the `changed` flags without a snapshot change, so always re-send.
      if (changed) yield* bump;
    }).pipe(Effect.withSpan("DriveService.sweep"));

    const logSkipped = <E>(cause: Cause.Cause<E>) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("drive sync sweep failed", { cause: Cause.pretty(cause) });

    const worker = yield* makeDrainableWorker(() => sweep.pipe(Effect.catchCause(logSkipped)));
    const requestSync = worker.enqueue(undefined);

    const linkDocument: DriveService["Service"]["linkDocument"] = (input) =>
      Effect.gen(function* () {
        const existing = yield* orStoreFailure(store.listThreadLinks(input.threadId));
        const views = yield* viewedVersions;
        let link: Omit<StoredDriveLink, "id" | "linkedAt">;
        if (isDriveArtifactId(input.reference)) {
          const { artifact } = yield* resolve(input.reference);
          link = {
            threadId: input.threadId,
            artifactId: artifact.id,
            url: canonicalArtifactUrl(artifact),
            folderSlug: null,
            slug: artifact.slug,
            shareToken: null,
            version: null,
            source: input.source,
            snapshot: null,
            syncState: "pending",
          };
        } else {
          const target = parseDriveUrl(input.reference, baseUrl);
          if (target === null || target.type === "folder")
            return yield* new DriveError({
              reason: "invalid_url",
              detail:
                target === null
                  ? "That is not a Drive document link."
                  : "That is a folder. Link one of its documents instead.",
            });
          link =
            target.type === "share-link"
              ? {
                  threadId: input.threadId,
                  artifactId: null,
                  url: target.url,
                  folderSlug: null,
                  slug: null,
                  shareToken: target.token,
                  version: null,
                  source: input.source,
                  snapshot: null,
                  syncState: "pending",
                }
              : {
                  threadId: input.threadId,
                  artifactId:
                    target.folderSlug === null || isDriveArtifactId(target.reference)
                      ? target.reference
                      : null,
                  url: target.url,
                  folderSlug: target.folderSlug,
                  slug: isDriveArtifactId(target.reference) ? null : target.reference,
                  shareToken: null,
                  version: target.version,
                  source: input.source,
                  snapshot: null,
                  syncState: "pending",
                };
        }
        const duplicate = existing.find(
          (entry) =>
            entry.url === link.url ||
            (link.artifactId !== null &&
              entry.artifactId === link.artifactId &&
              entry.version === link.version),
        );
        if (duplicate) return { link: toDriveThreadLink(duplicate, views), alreadyLinked: true };

        const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const now = yield* nowIso;
        const stored: StoredDriveLink = { ...link, id, linkedAt: now };
        yield* orStoreFailure(store.insertLink(stored, now));
        // Read it now so the badge shows a title; offline it shows "not connected".
        yield* syncLinks([stored]).pipe(Effect.timeout("10 seconds"), Effect.ignore);
        yield* bump;
        // A share link resolved to a document the thread already had: keep one.
        const after = yield* orStoreFailure(store.listThreadLinks(input.threadId));
        const fresh = after.find((entry) => entry.id === id) ?? stored;
        const twin = after.find(
          (entry) =>
            entry.id !== id &&
            fresh.artifactId !== null &&
            entry.artifactId === fresh.artifactId &&
            entry.version === fresh.version,
        );
        if (twin) {
          yield* orStoreFailure(store.deleteLink(input.threadId, id));
          yield* bump;
          return { link: toDriveThreadLink(twin, yield* viewedVersions), alreadyLinked: true };
        }
        return { link: toDriveThreadLink(fresh, yield* viewedVersions), alreadyLinked: false };
      });

    const unlinkDocument: DriveService["Service"]["unlinkDocument"] = (threadId, reference) =>
      Effect.gen(function* () {
        const links = yield* orStoreFailure(store.listThreadLinks(threadId));
        const parsed = parseDriveUrl(reference, baseUrl);
        const match = links.find(
          (link) =>
            link.id === reference ||
            link.artifactId === reference ||
            link.url === reference ||
            (parsed !== null && link.url === parsed.url) ||
            (parsed?.type === "document" &&
              link.folderSlug === parsed.folderSlug &&
              link.slug === parsed.reference),
        );
        if (!match) return { wasLinked: false };
        yield* orStoreFailure(store.deleteLink(threadId, match.id));
        yield* bump;
        return { wasLinked: true };
      });

    // ----- documents -----------------------------------------------------------

    const listDocuments: DriveService["Service"]["listDocuments"] = (input) =>
      withSession((token) =>
        Effect.gen(function* () {
          let artifacts: Array<Artifact>;
          if (input.scope === "shared") {
            artifacts = (yield* api.sharedWithMe({ token })).flatMap((item) =>
              item.artifact ? [item.artifact] : [],
            );
          } else if (input.scope === "folder") {
            artifacts = yield* api.listArtifacts({ token, folderId: input.folderId }, 100);
          } else {
            // Drive lists one folder at a time: the newest across your top folders.
            const roots = (yield* folders(token)).slice(0, 12);
            const lists = yield* Effect.forEach(
              roots,
              (folder) => api.listArtifacts({ token, folderId: folder.id }, 20),
              { concurrency: 4 },
            );
            artifacts = lists.flat();
          }
          const seen = new Set<string>();
          return artifacts
            .filter((artifact) => !seen.has(artifact.id) && seen.add(artifact.id))
            .map((artifact) => summaryOfArtifact(artifact, baseUrl))
            .filter((document) => !document.archived && matchesDocumentQuery(document, input.query))
            .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .slice(0, 100);
        }),
      );

    /** Writes a document read for its page onto the links that name it, like a sweep would. */
    const recordRead = (artifact: Artifact) =>
      Effect.gen(function* () {
        const links = (yield* store.listLinks).filter((link) => link.artifactId === artifact.id);
        if (links.length > 0 && (yield* recordArtifact(links, artifact))) yield* bump;
      }).pipe(Effect.ignore);

    const readText = (
      artifactId: string,
      token: string,
      version: number | undefined,
      maxBytes: number,
    ) =>
      api.readContent(artifactId, { token, version, maxBytes }).pipe(
        Effect.tapError((error) => (error.status === 401 ? connection.markRejected : Effect.void)),
        Effect.mapError(driveErrorOf),
      );

    const documentDetail: DriveService["Service"]["documentDetail"] = (reference, version) =>
      Effect.gen(function* () {
        const { artifact, token, target } = yield* resolve(reference);
        // A `/v<N>` link previews that version unless another is asked for.
        const requested =
          version ?? ("type" in target && target.type === "document" ? target.version : null);
        const versions = yield* api
          .listVersions(artifact.id, { token })
          .pipe(Effect.mapError(driveErrorOf));
        const selected = versions.find((entry) => entry.number === requested) ?? null;
        const entryPath = selected?.entryPath ?? artifact.currentVersion?.entryPath ?? null;
        const kind = entryPath === null ? null : driveDocumentKind("", entryPath);
        const previewVersion = selected?.number ?? artifact.currentVersion?.number ?? null;
        let preview: DriveDocumentPreview;
        if (previewVersion === null) {
          preview = { type: "none", reason: "This document has no published version yet." };
        } else if (isDriveTextKind(kind)) {
          const content = yield* readText(
            artifact.id,
            token,
            previewVersion,
            DRIVE_PREVIEW_MAX_BYTES,
          );
          preview = {
            type: "text",
            version: previewVersion,
            text: content.text,
            truncated: content.truncated,
          };
        } else {
          preview = {
            type: "none",
            reason:
              kind === "workbook"
                ? "Workbooks open in Drive."
                : kind === "video"
                  ? "Videos play in Drive."
                  : "This page renders in Drive.",
          };
        }
        yield* recordRead(artifact);
        const views = yield* viewedVersions;
        return {
          document: summaryOfArtifact(artifact, baseUrl),
          versions: versions.map(versionOf),
          preview,
          viewedVersion: views.get(artifact.id) ?? null,
        };
      });

    const readDocument: DriveService["Service"]["readDocument"] = (reference, version) =>
      Effect.gen(function* () {
        const { artifact, token } = yield* resolve(reference);
        const summary = summaryOfArtifact(artifact, baseUrl);
        const number = version ?? summary.version;
        if (number === null)
          return yield* new DriveError({
            reason: "not_found",
            detail: "This document has no published version yet.",
          });
        if (version === undefined && !isDriveTextKind(summary.kind))
          return yield* new DriveError({
            reason: "invalid_url",
            detail: `This is a ${summary.kind ?? "binary"} document; only markdown, text, CSV and TSV are readable as text. Open it in Drive: ${summary.url}`,
          });
        const content = yield* readText(artifact.id, token, number, DRIVE_READ_MAX_BYTES);
        return {
          document: summary,
          version: number,
          text: content.text,
          truncated: content.truncated,
        };
      });

    const createDocument: DriveService["Service"]["createDocument"] = (input) =>
      withSession((token) =>
        Effect.gen(function* () {
          const format = CONTENT_TYPES[input.format];
          const result = yield* api.createTextDocument(
            {
              slug: input.slug,
              title: input.title,
              description: input.description ?? "",
              entryPath: `${input.slug}.${format.extension}`,
              label: input.label ?? "Initial version",
              content: input.content,
              contentType: format.contentType,
            },
            { token, folderId: input.folderId },
          );
          return summaryOfArtifact(result.artifact, baseUrl);
        }),
      );

    const updateDocument: DriveService["Service"]["updateDocument"] = (input) =>
      Effect.gen(function* () {
        const { artifact, token } = yield* resolve(input.reference);
        const entryPath = artifact.currentVersion?.entryPath;
        const kind = entryPath === undefined ? null : driveDocumentKind("", entryPath);
        if (entryPath === undefined || !isDriveTextKind(kind) || kind === null)
          return yield* new DriveError({
            reason: "invalid_url",
            detail: "Only markdown, text, CSV and TSV documents can be updated here.",
          });
        const format = CONTENT_TYPES[kind as DriveTextFormat];
        const result = yield* api
          .publishTextVersion(
            artifact.id,
            {
              entryPath,
              label: input.label,
              content: input.content,
              contentType: format.contentType,
            },
            input.ifVersion,
            { token },
          )
          .pipe(Effect.mapError(driveErrorOf));
        yield* recordRead(result.artifact);
        return summaryOfArtifact(result.artifact, baseUrl);
      });

    const markViewed: DriveService["Service"]["markViewed"] = (artifactId, version) =>
      Effect.gen(function* () {
        yield* orStoreFailure(store.markViewed(artifactId, version, yield* nowIso));
        yield* bump;
      });

    const changedDocuments = Effect.gen(function* () {
      const [links, shared, views] = yield* Effect.all([
        store.listLinks,
        store.listShared,
        store.viewedVersions,
      ]);
      const entries = new Map<string, DriveHomeEntry>();
      const consider = (
        artifactId: string,
        snapshot: StoredDriveLink["snapshot"],
        url: string,
        threadId: string | null,
        isShared: boolean,
      ) => {
        if (snapshot === null || snapshot.version === null) return;
        const viewed = views.get(artifactId);
        if (viewed === undefined || viewed === null || snapshot.version <= viewed) return;
        const current = entries.get(artifactId);
        entries.set(artifactId, {
          artifactId,
          title: snapshot.title,
          url: current?.url ?? url,
          folderId: snapshot.folderId,
          folderSlug: snapshot.folderSlug,
          version: snapshot.version,
          viewedVersion: viewed,
          updatedAt: snapshot.updatedAt,
          updatedBy: snapshot.updatedBy,
          threadIds: [...(current?.threadIds ?? []), ...(threadId === null ? [] : [threadId])],
          shared: (current?.shared ?? false) || isShared,
        });
      };
      for (const link of links)
        if (link.artifactId !== null)
          consider(
            link.artifactId,
            link.snapshot,
            link.url.replace(/\/v\d+$/u, ""),
            link.threadId,
            false,
          );
      for (const document of shared)
        consider(document.artifactId, document.snapshot, document.url, null, true);
      return [...entries.values()].toSorted((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("drive home items unavailable", { cause: Cause.pretty(cause) }).pipe(
          Effect.as([] as ReadonlyArray<DriveHomeEntry>),
        ),
      ),
    );

    const start = Effect.gen(function* () {
      yield* forkParked(
        Effect.gen(function* () {
          yield* connection.refreshAccount.pipe(Effect.ignore);
          yield* worker.enqueue(undefined);
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced(SYNC_INTERVAL)), Effect.asVoid),
      );
      // Connecting (or being signed out) changes every link's state at once.
      yield* forkParked(
        Stream.runForEach(
          Stream.changesWith(
            connection.statusChanges,
            (left, right) => left.status === right.status,
          ),
          (status) =>
            status.status === "connected" || status.status === "disconnected"
              ? requestSync
              : Effect.void,
        ),
      );
    });

    return DriveService.of({
      baseUrl,
      status: connection.status,
      statusChanges: connection.statusChanges,
      connect: connection.connect,
      disconnect: connection.disconnect,
      listFolders: withSession((token) => folders(token)),
      listDocuments,
      documentDetail,
      readDocument,
      createDocument,
      updateDocument,
      markViewed,
      linkDocument,
      unlinkDocument,
      listThreadLinks: (threadId) =>
        orStoreFailure(
          Effect.gen(function* () {
            const [links, views] = yield* Effect.all([
              store.listThreadLinks(threadId),
              store.viewedVersions,
            ]);
            return links.map((link) => toDriveThreadLink(link, views));
          }),
        ),
      linkChanges: SubscriptionRef.changes(revision).pipe(
        Stream.mapEffect(() =>
          allLinks.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<DriveThreadLink>)),
        ),
        Stream.map((links) => ({ links })),
      ),
      changedDocuments,
      requestSync,
      syncNow: Effect.gen(function* () {
        yield* requestSync;
        yield* worker.drain;
      }),
      start,
    });
  });

/** The service on `suite.sqlite` and the configured Drive deployment. */
export const make = Effect.gen(function* () {
  const baseUrl = yield* DriveBaseUrlConfig;
  const api = yield* makeDriveApi(baseUrl);
  const store = yield* makeDriveStore;
  return yield* makeWith({ api, store });
});

export const layer = Layer.effect(DriveService, make).pipe(
  Layer.provide(SuiteDatabase.layerSqlClient),
  Layer.provide(FetchHttpClient.layer),
);

/** Starts the sync once the server activates. */
export const layerStart = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* DriveService;
    yield* service.start;
  }),
);
