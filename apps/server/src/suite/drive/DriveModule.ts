/**
 * Otter Drive in Otterware: the connection, documents, thread links and their
 * sync (`DriveService`), over RPC, as agent tools and on Home.
 */
import {
  SUITE_DRIVE_METHODS,
  SuiteDriveRpcGroup,
  SuiteHomeActionError,
  type SuiteHomeItem,
} from "@t3tools/contracts/suite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";

import { defineSuiteServerModule, type SuiteHomeContributor } from "../SuiteModule.ts";
import * as DriveService from "./DriveService.ts";
import { DRIVE_MIGRATIONS, DRIVE_MODULE_ID } from "./DriveStore.ts";
import * as DriveToolkit from "./DriveToolkit.ts";

const rpcHandlers = SuiteDriveRpcGroup.toLayer(
  Effect.gen(function* () {
    const drive = yield* DriveService.DriveService;
    return SuiteDriveRpcGroup.of({
      [SUITE_DRIVE_METHODS.status]: () => drive.status,
      [SUITE_DRIVE_METHODS.subscribeStatus]: () => drive.statusChanges,
      [SUITE_DRIVE_METHODS.connect]: () => drive.connect,
      [SUITE_DRIVE_METHODS.disconnect]: () => drive.disconnect,
      [SUITE_DRIVE_METHODS.listFolders]: () =>
        drive.listFolders.pipe(Effect.map((folders) => ({ folders }))),
      [SUITE_DRIVE_METHODS.listDocuments]: (input) =>
        drive.listDocuments(input).pipe(Effect.map((documents) => ({ documents }))),
      [SUITE_DRIVE_METHODS.documentDetail]: ({ reference, version }) =>
        drive.documentDetail(reference, version),
      [SUITE_DRIVE_METHODS.markViewed]: ({ artifactId, version }) =>
        drive.markViewed(artifactId, version),
      [SUITE_DRIVE_METHODS.linkDocument]: ({ threadId, url, source }) =>
        drive.linkDocument({ threadId, reference: url, source: source ?? "manual" }),
      [SUITE_DRIVE_METHODS.unlinkDocument]: ({ threadId, linkId }) =>
        drive.unlinkDocument(threadId, linkId),
      [SUITE_DRIVE_METHODS.listThreadLinks]: ({ threadId }) =>
        drive.listThreadLinks(threadId).pipe(Effect.map((links) => ({ links }))),
      [SUITE_DRIVE_METHODS.subscribeThreadLinks]: () => drive.linkChanges,
    });
  }),
);

const HOME_ITEM_PREFIX = "drive-document:";

/** Linked or shared documents with versions the user has not seen. */
const homeContributor = Effect.gen(function* () {
  const drive = yield* DriveService.DriveService;
  return {
    module: "drive",
    needsYou: drive.changedDocuments.pipe(
      Effect.map((entries) =>
        entries.map((entry): SuiteHomeItem => {
          const delta = entry.version - entry.viewedVersion;
          const versions =
            delta === 1 ? `v${entry.version}` : `v${entry.viewedVersion} → v${entry.version}`;
          return {
            id: `${HOME_ITEM_PREFIX}${entry.artifactId}`,
            module: "drive",
            kind: "drive.document-changed",
            title: entry.title,
            subtitle: [
              entry.updatedBy
                ? `${entry.updatedBy} published ${versions}`
                : `${versions} published`,
              entry.threadIds.length > 0
                ? `linked to ${entry.threadIds.length} thread${entry.threadIds.length === 1 ? "" : "s"}`
                : entry.shared
                  ? "shared with you"
                  : null,
            ]
              .filter((part) => part !== null)
              .join(" · "),
            occurredAt: entry.updatedAt,
            priority: entry.threadIds.length > 0 ? 40 : 30,
            actions: [
              { id: "see-changes", label: "See changes", primary: true },
              { id: "open", label: "Open" },
              { id: "mark-seen", label: "Mark as seen" },
            ],
            target: {
              route: "/drive",
              params: {
                url: entry.url,
                artifactId: entry.artifactId,
                folderId: entry.folderId,
                folderSlug: entry.folderSlug,
                version: String(entry.version),
                viewedVersion: String(entry.viewedVersion),
                threadIds: entry.threadIds.join(","),
              },
            },
          };
        }),
      ),
    ),
    // Every action means the user looked (or chose not to): it stops being new.
    performAction: (itemId, actionId) =>
      Effect.gen(function* () {
        const artifactId = itemId.startsWith(HOME_ITEM_PREFIX)
          ? itemId.slice(HOME_ITEM_PREFIX.length)
          : null;
        const entry = (yield* drive.changedDocuments).find(
          (candidate) => candidate.artifactId === artifactId,
        );
        if (!entry) return;
        yield* drive.markViewed(entry.artifactId, entry.version);
      }).pipe(
        Effect.mapError(
          (cause) => new SuiteHomeActionError({ module: "drive", itemId, actionId, cause }),
        ),
      ),
  } satisfies SuiteHomeContributor;
});

export const DriveModule = defineSuiteServerModule({
  id: DRIVE_MODULE_ID,
  migrations: DRIVE_MIGRATIONS,
  layer: DriveService.layerStart.pipe(Layer.provideMerge(DriveService.layer)),
  rpcHandlers,
  mcpToolkit: McpServer.toolkit(DriveToolkit.DriveToolkit).pipe(
    Layer.provide(DriveToolkit.layerHandlers),
  ),
  homeContributor,
  agentInstructions: `## Otter Drive

The user's documents live in Otter Drive (drive.otterware.app). Use the \`drive_\` tools for them, not the \`otterdrive\` CLI. Inspect before changing (\`drive_get_document\`), and pass the inspected version as \`ifVersion\` to \`drive_update_document\`; on a conflict, re-read and report it instead of retrying. Versions are immutable. Never share a document unless the user asks. Link the Drive documents a thread works on with \`drive_link_document_to_thread\`, and report a document's URL after creating or updating it.`,
});
