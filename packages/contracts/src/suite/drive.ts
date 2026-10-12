/**
 * Otter Drive in Otterware: the connection to drive.otterware.app, documents
 * read through its API, and Drive documents linked to Code threads (the way
 * Linear issues and pull requests are). Links live in the server's
 * `suite.sqlite`, never in the thread projections.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import { IsoDateTime, PositiveInt, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { defineSuiteContract } from "./contract.ts";

export const DRIVE_DEFAULT_BASE_URL = "https://drive.otterware.app";
/** Hosts Drive moved away from; they redirect to `drive.otterware.app` with path and query. */
export const DRIVE_LEGACY_HOSTS: ReadonlyArray<string> = [
  "app.otterware.dev",
  "drive.otterware.dev",
];
/** Raw document content (`/raw/a/<artifactId>/<versionId>/...`), never a page of its own. */
export const DRIVE_CONTENT_HOST = "usercontent.otterware.app";

export const DriveDocumentKind = Schema.Literals([
  "markdown",
  "text",
  "csv",
  "tsv",
  "workbook",
  "video",
  "frame",
]);
export type DriveDocumentKind = typeof DriveDocumentKind.Type;

/** Drive's own format decision (`apps/web/src/lib/document-kind.ts` upstream), from the entry file. */
export function driveDocumentKind(contentType: string, entryPath: string): DriveDocumentKind {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const extension = entryPath.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "tsv" || type === "text/tab-separated-values") return "tsv";
  if (extension === "csv" || type === "text/csv") return "csv";
  if (
    extension === "xlsx" ||
    type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
    return "workbook";
  if (["md", "markdown"].includes(extension) || type === "text/markdown") return "markdown";
  if (extension === "txt" || type === "text/plain") return "text";
  if (type.startsWith("video/") || ["mp4", "m4v", "webm", "mov", "ogv"].includes(extension))
    return "video";
  return "frame";
}

/** Kinds whose content is text an agent or the preview can read directly. */
export function isDriveTextKind(kind: DriveDocumentKind | null): boolean {
  return kind === "markdown" || kind === "text" || kind === "csv" || kind === "tsv";
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** First path segments that are Drive app routes, never a folder slug. */
const DRIVE_APP_ROUTES = new Set([
  "api",
  "raw",
  "s",
  "home",
  "settings",
  "login",
  "device",
  "invite",
  "forgot-password",
  "reset-password",
]);

export type DriveUrlTarget =
  /**
   * `/<folderSlug>/a/<slugOrId>[/v<N>]`: a document. `reference` is the slug,
   * or the id when it is shared on its own (outside every folder you can open).
   */
  | {
      readonly type: "document";
      readonly folderSlug: string | null;
      readonly reference: string;
      readonly version: number | null;
      readonly sheet: string | null;
      readonly url: string;
    }
  /** `/s/<token>`: an "anyone with the link" share of a document or folder. */
  | { readonly type: "share-link"; readonly token: string; readonly url: string }
  /** `/home?folder=<id>` (or `/home`, the default drive). */
  | { readonly type: "folder"; readonly folderId: string | null; readonly url: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isDriveArtifactId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Whether `hostname` serves Drive pages: the configured host, Drive's own, or a legacy one. */
export function isDriveHost(hostname: string, baseUrl: string = DRIVE_DEFAULT_BASE_URL): boolean {
  const host = hostname.toLowerCase();
  let configured: string | null = null;
  try {
    configured = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    configured = null;
  }
  return (
    host === configured ||
    host === new URL(DRIVE_DEFAULT_BASE_URL).hostname ||
    DRIVE_LEGACY_HOSTS.includes(host)
  );
}

/**
 * Reads any Drive link people paste: documents (current or `/v<N>`, legacy
 * `?version=N`, `?sheet=`), share links, folders, legacy hosts and raw content
 * URLs. Null for anything else. `url` is canonical on `baseUrl`'s origin.
 */
export function parseDriveUrl(
  input: string,
  baseUrl: string = DRIVE_DEFAULT_BASE_URL,
): DriveUrlTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const origin = new URL(baseUrl).origin;
  const segments = parsed.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });

  if (parsed.hostname.toLowerCase() === DRIVE_CONTENT_HOST) {
    // /raw/a/<artifactId>/<versionId>/<path>
    const artifactId = segments[0] === "raw" && segments[1] === "a" ? segments[2] : undefined;
    return artifactId && isDriveArtifactId(artifactId)
      ? {
          type: "document",
          folderSlug: null,
          reference: artifactId,
          version: null,
          sheet: null,
          url: `${origin}/`,
        }
      : null;
  }
  if (!isDriveHost(parsed.hostname, baseUrl)) return null;

  const [first, second, third, fourth] = segments;
  if (first === "s" && second && segments.length === 2) {
    return { type: "share-link", token: second, url: `${origin}/s/${encodeURIComponent(second)}` };
  }
  if (first === "home" && segments.length === 1) {
    const folderId = parsed.searchParams.get("folder");
    return {
      type: "folder",
      folderId,
      url: `${origin}/home${folderId ? `?folder=${encodeURIComponent(folderId)}` : ""}`,
    };
  }
  if (first && !DRIVE_APP_ROUTES.has(first) && second === "a" && third) {
    const versionSegment = fourth?.match(/^v([1-9][0-9]*)$/u)?.[1];
    if (fourth !== undefined && versionSegment === undefined) return null;
    if (segments.length > 4) return null;
    const queryVersion = parsed.searchParams.get("version");
    const version = versionSegment
      ? Number(versionSegment)
      : queryVersion && /^[1-9][0-9]*$/u.test(queryVersion)
        ? Number(queryVersion)
        : null;
    const sheet = parsed.searchParams.get("sheet");
    return {
      type: "document",
      folderSlug: first,
      reference: third,
      version,
      sheet: sheet && sheet.trim().length > 0 ? sheet : null,
      url: driveDocumentUrl(baseUrl, first, third, version, sheet),
    };
  }
  return null;
}

/** `https://drive.otterware.app/<folderSlug>/a/<slugOrId>[/v<N>][?sheet=<name>]`. */
export function driveDocumentUrl(
  baseUrl: string,
  folderSlug: string,
  reference: string,
  version?: number | null,
  sheet?: string | null,
): string {
  const origin = new URL(baseUrl).origin;
  const path = `/${encodeURIComponent(folderSlug)}/a/${encodeURIComponent(reference)}`;
  const query = sheet?.trim() ? `?sheet=${encodeURIComponent(sheet)}` : "";
  return `${origin}${path}${version ? `/v${version}` : ""}${query}`;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export const DriveAccount = Schema.Struct({
  userId: Schema.NullOr(Schema.String),
  name: Schema.String,
});
export type DriveAccount = typeof DriveAccount.Type;

/**
 * How this server reads Drive. `pending` shows the device-flow code the user
 * enters at `verificationUri`; the server polls Drive until it is approved.
 */
export const DriveConnectionStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("disconnected"), baseUrl: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("pending"),
    baseUrl: Schema.String,
    userCode: Schema.String,
    verificationUri: Schema.String,
    verificationUriComplete: Schema.String,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("connected"),
    baseUrl: Schema.String,
    account: Schema.NullOr(DriveAccount),
  }),
  Schema.Struct({
    status: Schema.Literal("error"),
    baseUrl: Schema.String,
    message: Schema.String,
  }),
]);
export type DriveConnectionStatus = typeof DriveConnectionStatus.Type;

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const DriveRole = Schema.Literals(["owner", "editor", "viewer"]);
export type DriveRole = typeof DriveRole.Type;

export const DriveFolder = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["personal", "shared", "folder"]),
  role: DriveRole,
  shared: Schema.Boolean,
});
export type DriveFolder = typeof DriveFolder.Type;

/** One document as lists, links and Home show it. */
export const DriveDocumentSummary = Schema.Struct({
  artifactId: Schema.String,
  folderId: Schema.String,
  /** The folder's slug in the document URL; the id for a document shared on its own. */
  folderSlug: Schema.String,
  slug: Schema.String,
  title: Schema.String,
  description: Schema.String,
  kind: Schema.NullOr(DriveDocumentKind),
  /** Current version number; null before the first version is published. */
  version: Schema.NullOr(Schema.Int),
  versionLabel: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
  /** Who published the current version. */
  updatedBy: Schema.NullOr(Schema.String),
  url: Schema.String,
  thumbnailUrl: Schema.NullOr(Schema.String),
  role: Schema.NullOr(DriveRole),
  shared: Schema.Boolean,
  archived: Schema.Boolean,
});
export type DriveDocumentSummary = typeof DriveDocumentSummary.Type;

export const DriveDocumentVersion = Schema.Struct({
  number: Schema.Int,
  label: Schema.String,
  createdAt: IsoDateTime,
  createdBy: Schema.NullOr(Schema.String),
  byteSize: Schema.Int,
  fileCount: Schema.Int,
});
export type DriveDocumentVersion = typeof DriveDocumentVersion.Type;

export const DriveDocumentPreview = Schema.Union([
  /** The entry file's text, for markdown/text/csv/tsv. */
  Schema.Struct({
    type: Schema.Literal("text"),
    version: Schema.Int,
    text: Schema.String,
    truncated: Schema.Boolean,
  }),
  /** Workbooks, videos and HTML pages are only viewable in Drive itself. */
  Schema.Struct({ type: Schema.Literal("none"), reason: Schema.String }),
]);
export type DriveDocumentPreview = typeof DriveDocumentPreview.Type;

export const DriveDocumentDetail = Schema.Struct({
  document: DriveDocumentSummary,
  versions: Schema.Array(DriveDocumentVersion),
  preview: DriveDocumentPreview,
  /** The version you last looked at here or in the Drive view; null when never. */
  viewedVersion: Schema.NullOr(Schema.Int),
});
export type DriveDocumentDetail = typeof DriveDocumentDetail.Type;

// ---------------------------------------------------------------------------
// Thread links
// ---------------------------------------------------------------------------

export const DriveThreadLinkSource = Schema.Literals(["manual", "agent"]);
export type DriveThreadLinkSource = typeof DriveThreadLinkSource.Type;

/** Why a link shows no fresh snapshot. */
export const DriveLinkSyncState = Schema.Literals([
  "pending",
  "synced",
  "not_connected",
  "not_found",
  "unavailable",
]);
export type DriveLinkSyncState = typeof DriveLinkSyncState.Type;

export const DriveDocumentSnapshot = Schema.Struct({
  title: Schema.String,
  kind: Schema.NullOr(DriveDocumentKind),
  folderId: Schema.String,
  folderSlug: Schema.String,
  slug: Schema.String,
  version: Schema.NullOr(Schema.Int),
  versionLabel: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
  updatedBy: Schema.NullOr(Schema.String),
  archived: Schema.Boolean,
  syncedAt: IsoDateTime,
});
export type DriveDocumentSnapshot = typeof DriveDocumentSnapshot.Type;

/**
 * A Drive document linked to a thread. The URL can name a slug, which can
 * change, so `artifactId` is filled in by the first successful read and keys
 * the link from then on.
 */
export const DriveThreadLink = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  artifactId: Schema.NullOr(Schema.String),
  url: Schema.String,
  folderSlug: Schema.NullOr(Schema.String),
  slug: Schema.NullOr(Schema.String),
  /** The version the link names (`/v<N>`); null follows the current version. */
  version: Schema.NullOr(Schema.Int),
  source: DriveThreadLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.NullOr(DriveDocumentSnapshot),
  syncState: DriveLinkSyncState,
  /** A newer version than the one last viewed in Otterware. */
  changed: Schema.Boolean,
});
export type DriveThreadLink = typeof DriveThreadLink.Type;

/** The label a link shows before it ever synced: the slug from its URL. */
export function driveThreadLinkTitle(link: Pick<DriveThreadLink, "snapshot" | "slug" | "url">) {
  return link.snapshot?.title ?? link.slug ?? link.url;
}

export class DriveError extends Schema.TaggedError<DriveError>()("DriveError", {
  reason: Schema.Literals([
    "not_connected",
    "invalid_url",
    "not_found",
    "forbidden",
    "conflict",
    "unavailable",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const DriveRpcError = Schema.Union([DriveError, EnvironmentAuthorizationError]);

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export const SUITE_DRIVE_METHODS = {
  status: "suite.drive.status",
  subscribeStatus: "suite.drive.subscribeStatus",
  connect: "suite.drive.connect",
  syncAccount: "suite.drive.syncAccount",
  disconnect: "suite.drive.disconnect",
  listFolders: "suite.drive.listFolders",
  listDocuments: "suite.drive.listDocuments",
  documentDetail: "suite.drive.documentDetail",
  markViewed: "suite.drive.markViewed",
  linkDocument: "suite.drive.linkDocument",
  unlinkDocument: "suite.drive.unlinkDocument",
  listThreadLinks: "suite.drive.listThreadLinks",
  subscribeThreadLinks: "suite.drive.subscribeThreadLinks",
} as const;

export const DriveListDocumentsInput = Schema.Struct({
  /** `recent`: your drives' latest documents; `shared`: shared with you; `folder`: one folder. */
  scope: Schema.Literals(["recent", "shared", "folder"]),
  folderId: Schema.optional(Schema.String),
  /** Filters by title, slug and description (Drive's API has no search). */
  query: Schema.optional(Schema.String),
});
export type DriveListDocumentsInput = typeof DriveListDocumentsInput.Type;

const DriveStatusRpc = Rpc.make(SUITE_DRIVE_METHODS.status, {
  payload: Schema.Struct({}),
  success: DriveConnectionStatus,
  error: EnvironmentAuthorizationError,
});

const DriveSubscribeStatusRpc = Rpc.make(SUITE_DRIVE_METHODS.subscribeStatus, {
  payload: Schema.Struct({}),
  success: DriveConnectionStatus,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const DriveConnectRpc = Rpc.make(SUITE_DRIVE_METHODS.connect, {
  payload: Schema.Struct({}),
  success: DriveConnectionStatus,
  error: DriveRpcError,
});

const DriveDisconnectRpc = Rpc.make(SUITE_DRIVE_METHODS.disconnect, {
  payload: Schema.Struct({}),
  success: DriveConnectionStatus,
  error: DriveRpcError,
});

const DriveSyncAccountRpc = Rpc.make(SUITE_DRIVE_METHODS.syncAccount, {
  payload: Schema.Struct({ token: Schema.NullOr(Schema.String) }),
  success: DriveConnectionStatus,
  error: DriveRpcError,
});

const DriveListFoldersRpc = Rpc.make(SUITE_DRIVE_METHODS.listFolders, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ folders: Schema.Array(DriveFolder) }),
  error: DriveRpcError,
});

const DriveListDocumentsRpc = Rpc.make(SUITE_DRIVE_METHODS.listDocuments, {
  payload: DriveListDocumentsInput,
  success: Schema.Struct({ documents: Schema.Array(DriveDocumentSummary) }),
  error: DriveRpcError,
});

const DriveDocumentDetailRpc = Rpc.make(SUITE_DRIVE_METHODS.documentDetail, {
  payload: Schema.Struct({
    /** The artifact id, or any Drive document URL. */
    reference: TrimmedNonEmptyString,
    /** Preview this version instead of the current one. */
    version: Schema.optional(PositiveInt),
  }),
  success: DriveDocumentDetail,
  error: DriveRpcError,
});

const DriveMarkViewedRpc = Rpc.make(SUITE_DRIVE_METHODS.markViewed, {
  payload: Schema.Struct({ artifactId: TrimmedNonEmptyString, version: Schema.Int }),
  success: Schema.Void,
  error: DriveRpcError,
});

const DriveLinkDocumentRpc = Rpc.make(SUITE_DRIVE_METHODS.linkDocument, {
  payload: Schema.Struct({
    threadId: ThreadId,
    /** Any Drive document or share URL. */
    url: TrimmedNonEmptyString,
    source: Schema.optional(DriveThreadLinkSource),
  }),
  success: Schema.Struct({ link: DriveThreadLink, alreadyLinked: Schema.Boolean }),
  error: DriveRpcError,
});

const DriveUnlinkDocumentRpc = Rpc.make(SUITE_DRIVE_METHODS.unlinkDocument, {
  payload: Schema.Struct({ threadId: ThreadId, linkId: TrimmedNonEmptyString }),
  success: Schema.Struct({ wasLinked: Schema.Boolean }),
  error: DriveRpcError,
});

const DriveListThreadLinksRpc = Rpc.make(SUITE_DRIVE_METHODS.listThreadLinks, {
  payload: Schema.Struct({ threadId: ThreadId }),
  success: Schema.Struct({ links: Schema.Array(DriveThreadLink) }),
  error: DriveRpcError,
});

/** Every thread's links, re-sent whole whenever one changes. Few enough to send whole. */
const DriveSubscribeThreadLinksRpc = Rpc.make(SUITE_DRIVE_METHODS.subscribeThreadLinks, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ links: Schema.Array(DriveThreadLink) }),
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const SuiteDriveRpcGroup = RpcGroup.make(
  DriveStatusRpc,
  DriveSubscribeStatusRpc,
  DriveConnectRpc,
  DriveDisconnectRpc,
  DriveSyncAccountRpc,
  DriveListFoldersRpc,
  DriveListDocumentsRpc,
  DriveDocumentDetailRpc,
  DriveMarkViewedRpc,
  DriveLinkDocumentRpc,
  DriveUnlinkDocumentRpc,
  DriveListThreadLinksRpc,
  DriveSubscribeThreadLinksRpc,
);

export const SuiteDriveContract = defineSuiteContract({
  group: SuiteDriveRpcGroup,
  scopes: {
    [SUITE_DRIVE_METHODS.status]: AuthOrchestrationReadScope,
    [SUITE_DRIVE_METHODS.subscribeStatus]: AuthOrchestrationReadScope,
    [SUITE_DRIVE_METHODS.connect]: AuthOrchestrationOperateScope,
    [SUITE_DRIVE_METHODS.disconnect]: AuthOrchestrationOperateScope,
    [SUITE_DRIVE_METHODS.syncAccount]: AuthOrchestrationOperateScope,
    [SUITE_DRIVE_METHODS.listFolders]: AuthOrchestrationReadScope,
    [SUITE_DRIVE_METHODS.listDocuments]: AuthOrchestrationReadScope,
    [SUITE_DRIVE_METHODS.documentDetail]: AuthOrchestrationReadScope,
    [SUITE_DRIVE_METHODS.markViewed]: AuthOrchestrationOperateScope,
    [SUITE_DRIVE_METHODS.linkDocument]: AuthOrchestrationOperateScope,
    [SUITE_DRIVE_METHODS.unlinkDocument]: AuthOrchestrationOperateScope,
    [SUITE_DRIVE_METHODS.listThreadLinks]: AuthOrchestrationReadScope,
    [SUITE_DRIVE_METHODS.subscribeThreadLinks]: AuthOrchestrationReadScope,
  },
});

/** The native Drive view's isolated IPC boundary; it never receives the API token. */
export interface DriveDesktopState {
  readonly url: string;
  readonly title: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading: boolean;
  readonly failed: string | null;
}

export interface DriveDesktopBridge {
  syncAccount: (token: string | null) => Promise<void>;
  onSignOut: (listener: () => void) => () => void;
  openDriveUrl: (url: string, baseUrl: string) => Promise<DriveDesktopState>;
  setBounds: (
    bounds: { x: number; y: number; width: number; height: number } | null,
  ) => Promise<void>;
  command: (command: "back" | "forward" | "reload") => Promise<void>;
  onState: (listener: (state: DriveDesktopState) => void) => () => void;
}
