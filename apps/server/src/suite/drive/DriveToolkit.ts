/**
 * Otter Drive for agents in every Code thread (`suite` MCP capability): read
 * folders and documents, publish text documents with optimistic concurrency,
 * and link documents to the calling thread like Linear issues.
 */
import { McpCapabilityUnavailableError, TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  DriveDocumentSummary,
  DriveDocumentVersion,
  DriveError,
  DriveFolder,
  DriveThreadLink,
} from "@t3tools/contracts/suite";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { DriveService } from "./DriveService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

/** Thread link tools act on the calling thread, which an agent signed in through MCP OAuth lacks. */
export class DriveNoCallingThreadError extends Schema.TaggedError<DriveNoCallingThreadError>()(
  "DriveNoCallingThreadError",
  {},
) {
  override get message(): string {
    return "Drive thread link tools only work from inside an Otter Code thread.";
  }
}

const DriveToolError = Schema.Union([
  McpCapabilityUnavailableError,
  DriveError,
  DriveNoCallingThreadError,
]);

const DocumentReference = TrimmedNonEmptyString.annotate({
  description:
    "The document's id, or its Drive URL, e.g. https://drive.otterware.app/<folder>/a/<slug> (a /v<N> URL names that version; share links /s/<token> work too).",
});

const ListFoldersTool = Tool.make("drive_list_folders", {
  description:
    "List the user's Otter Drive drives and folders (personal drive, shared drives, folders shared with them), with their role in each.",
  success: Schema.Struct({ folders: Schema.Array(DriveFolder) }),
  failure: DriveToolError,
  dependencies,
})
  .annotate(Tool.Title, "List Drive folders")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ListDocumentsTool = Tool.make("drive_list_documents", {
  description:
    "List Otter Drive documents, newest first: `recent` across the user's drives, `shared` (shared with them), or one `folder`. `query` filters by title, slug and description.",
  parameters: Schema.Struct({
    scope: Schema.Literals(["recent", "shared", "folder"]),
    folderId: Schema.optional(
      Schema.String.annotate({
        description: "Required for scope=folder; ids come from drive_list_folders.",
      }),
    ),
    query: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ documents: Schema.Array(DriveDocumentSummary) }),
  failure: DriveToolError,
  dependencies,
})
  .annotate(Tool.Title, "List Drive documents")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const GetDocumentTool = Tool.make("drive_get_document", {
  description:
    "Inspect an Otter Drive document before changing it: metadata, kind, current version and every immutable version.",
  parameters: Schema.Struct({ document: DocumentReference }),
  success: Schema.Struct({
    document: DriveDocumentSummary,
    versions: Schema.Array(DriveDocumentVersion),
  }),
  failure: DriveToolError,
  dependencies,
})
  .annotate(Tool.Title, "Get Drive document")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ReadDocumentTool = Tool.make("drive_read_document", {
  description:
    "Read a text document's content (markdown, text, CSV, TSV) from Otter Drive, the current version or `version`. Long documents are cut at 256 KB (truncated=true).",
  parameters: Schema.Struct({
    document: DocumentReference,
    version: Schema.optional(Schema.Int),
  }),
  success: Schema.Struct({
    document: DriveDocumentSummary,
    version: Schema.Int,
    text: Schema.String,
    truncated: Schema.Boolean,
  }),
  failure: DriveToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read Drive document")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const CreateDocumentTool = Tool.make("drive_create_document", {
  description:
    "Create a new Otter Drive document with version 1 from text. Personal-drive documents stay private until shared; this never shares. Use drive_update_document for an existing document.",
  parameters: Schema.Struct({
    title: TrimmedNonEmptyString,
    slug: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)).annotate({
      description: "URL slug: lowercase letters, digits and dashes, unique in the folder.",
    }),
    format: Schema.Literals(["markdown", "text", "csv", "tsv"]),
    content: Schema.String,
    description: Schema.optional(Schema.String),
    folderId: Schema.optional(
      Schema.String.annotate({
        description: "Where to create it; defaults to the user's personal drive.",
      }),
    ),
    label: Schema.optional(Schema.String.annotate({ description: "Version label." })),
  }),
  success: Schema.Struct({ document: DriveDocumentSummary }),
  failure: DriveToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create Drive document")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const UpdateDocumentTool = Tool.make("drive_update_document", {
  description:
    "Publish new content as a new immutable version of a text document. `ifVersion` must be the current version you inspected; on a conflict, re-read the document and its versions and report the conflict instead of retrying blindly.",
  parameters: Schema.Struct({
    document: DocumentReference,
    content: Schema.String,
    ifVersion: Schema.Int,
    label: TrimmedNonEmptyString.annotate({ description: "What changed in this version." }),
  }),
  success: Schema.Struct({ document: DriveDocumentSummary }),
  failure: DriveToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update Drive document")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const LinkDocumentTool = Tool.make("drive_link_document_to_thread", {
  description:
    "Link an Otter Drive document to this thread so it shows beside the thread, like a linked issue. Link the documents you work on or the user names. Linking an already-linked document succeeds with alreadyLinked=true.",
  parameters: Schema.Struct({ document: DocumentReference }),
  success: Schema.Struct({ link: DriveThreadLink, alreadyLinked: Schema.Boolean }),
  failure: DriveToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link Drive document to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkDocumentTool = Tool.make("drive_unlink_document_from_thread", {
  description:
    "Remove a Drive document link from this thread (by document id, URL or link id). Unlinking a document that is not linked succeeds with wasLinked=false.",
  parameters: Schema.Struct({ document: DocumentReference }),
  success: Schema.Struct({ wasLinked: Schema.Boolean }),
  failure: DriveToolError,
  dependencies,
})
  .annotate(Tool.Title, "Unlink Drive document from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadDocumentsTool = Tool.make("drive_list_thread_documents", {
  description:
    "List the Drive documents linked to this thread with their last synced title and version. `changed` marks a newer version than the user last looked at.",
  success: Schema.Struct({ links: Schema.Array(DriveThreadLink) }),
  failure: DriveToolError,
  dependencies,
})
  .annotate(Tool.Title, "List thread Drive documents")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const DriveToolkit = Toolkit.make(
  ListFoldersTool,
  ListDocumentsTool,
  GetDocumentTool,
  ReadDocumentTool,
  CreateDocumentTool,
  UpdateDocumentTool,
  LinkDocumentTool,
  UnlinkDocumentTool,
  ListThreadDocumentsTool,
);

export const layerHandlers = DriveToolkit.toLayer(
  Effect.gen(function* () {
    const drive = yield* DriveService;
    const suite = McpInvocationContext.requireMcpCapability("suite");
    const callingThread = suite.pipe(
      Effect.flatMap((scope) =>
        scope.thread === undefined
          ? Effect.fail(new DriveNoCallingThreadError({}))
          : Effect.succeed(scope.thread.threadId as string),
      ),
    );
    return DriveToolkit.of({
      drive_list_folders: () =>
        suite.pipe(
          Effect.andThen(drive.listFolders),
          Effect.map((folders) => ({ folders })),
        ),
      drive_list_documents: (input) =>
        suite.pipe(
          Effect.andThen(drive.listDocuments(input)),
          Effect.map((documents) => ({ documents })),
        ),
      drive_get_document: ({ document }) =>
        suite.pipe(
          Effect.andThen(drive.documentDetail(document)),
          Effect.map((detail) => ({ document: detail.document, versions: detail.versions })),
        ),
      drive_read_document: ({ document, version }) =>
        suite.pipe(Effect.andThen(drive.readDocument(document, version))),
      drive_create_document: (input) =>
        suite.pipe(
          Effect.andThen(drive.createDocument(input)),
          Effect.map((document) => ({ document })),
        ),
      drive_update_document: ({ document, content, ifVersion, label }) =>
        suite.pipe(
          Effect.andThen(drive.updateDocument({ reference: document, content, ifVersion, label })),
          Effect.map((updated) => ({ document: updated })),
        ),
      drive_link_document_to_thread: ({ document }) =>
        callingThread.pipe(
          Effect.flatMap((threadId) =>
            drive.linkDocument({ threadId, reference: document, source: "agent" }),
          ),
        ),
      drive_unlink_document_from_thread: ({ document }) =>
        callingThread.pipe(Effect.flatMap((threadId) => drive.unlinkDocument(threadId, document))),
      drive_list_thread_documents: () =>
        callingThread.pipe(
          Effect.flatMap((threadId) => drive.listThreadLinks(threadId)),
          Effect.map((links) => ({ links })),
        ),
    });
  }),
);
