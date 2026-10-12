/** Drive's API shapes (vendored Zod contracts) to Otterware's wire shapes. Pure. */
import type { Artifact, ArtifactVersion, Folder } from "@otterware/drive-contracts";
import {
  type DriveDocumentSnapshot,
  type DriveDocumentSummary,
  type DriveDocumentVersion,
  type DriveFolder,
  driveDocumentKind,
  parseDriveUrl,
} from "@t3tools/contracts/suite";

/** Drive's own document URL, without the trailing slash its API adds. */
export function canonicalArtifactUrl(artifact: Pick<Artifact, "url">): string {
  return artifact.url.replace(/\/+$/u, "");
}

/** The folder slug in the document's URL (the folder it lives in). */
export function artifactFolderSlug(artifact: Pick<Artifact, "url" | "folderId">, baseUrl: string) {
  const target = parseDriveUrl(artifact.url, baseUrl);
  return target?.type === "document" && target.folderSlug !== null
    ? target.folderSlug
    : artifact.folderId;
}

export function artifactKind(artifact: Pick<Artifact, "currentVersion">) {
  const entryPath = artifact.currentVersion?.entryPath;
  return entryPath === undefined ? null : driveDocumentKind("", entryPath);
}

export function summaryOfArtifact(artifact: Artifact, baseUrl: string): DriveDocumentSummary {
  return {
    artifactId: artifact.id,
    folderId: artifact.folderId,
    folderSlug: artifactFolderSlug(artifact, baseUrl),
    slug: artifact.slug,
    title: artifact.title,
    description: artifact.description,
    kind: artifactKind(artifact),
    version: artifact.currentVersion?.number ?? null,
    versionLabel: artifact.currentVersion?.label ?? null,
    updatedAt: artifact.currentVersion?.createdAt ?? artifact.updatedAt,
    updatedBy: artifact.currentVersion?.createdBy?.name ?? null,
    url: canonicalArtifactUrl(artifact),
    thumbnailUrl: artifact.thumbnailUrl ?? null,
    role: artifact.role ?? null,
    shared: artifact.shared ?? false,
    archived: artifact.archivedAt !== null,
  };
}

export function snapshotOfArtifact(
  artifact: Artifact,
  baseUrl: string,
  syncedAt: string,
): DriveDocumentSnapshot {
  const summary = summaryOfArtifact(artifact, baseUrl);
  return {
    title: summary.title,
    kind: summary.kind,
    folderId: summary.folderId,
    folderSlug: summary.folderSlug,
    slug: summary.slug,
    version: summary.version,
    versionLabel: summary.versionLabel,
    updatedAt: summary.updatedAt,
    updatedBy: summary.updatedBy,
    archived: summary.archived,
    syncedAt,
  };
}

export function versionOf(version: ArtifactVersion): DriveDocumentVersion {
  return {
    number: version.number,
    label: version.label,
    createdAt: version.createdAt,
    createdBy: version.createdBy?.name ?? null,
    byteSize: version.byteSize,
    fileCount: version.fileCount,
  };
}

export function folderOf(folder: Folder): DriveFolder {
  return {
    id: folder.id,
    name: folder.name,
    slug: folder.slug,
    parentId: folder.parentId,
    kind: folder.kind,
    role: folder.role,
    shared: folder.shared ?? false,
  };
}

/** Case-insensitive match on title, slug and description; Drive's API has no search. */
export function matchesDocumentQuery(document: DriveDocumentSummary, query: string | undefined) {
  const needle = query?.trim().toLowerCase();
  if (!needle) return true;
  return [document.title, document.slug, document.description].some((value) =>
    value.toLowerCase().includes(needle),
  );
}
