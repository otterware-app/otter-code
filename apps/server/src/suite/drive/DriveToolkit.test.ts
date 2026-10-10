import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { suiteToolkitRegistration } from "../mcpRegistration.ts";
import { DriveService } from "./DriveService.ts";
import { DriveToolkit, layerHandlers } from "./DriveToolkit.ts";

it.effect(
  "offers all Drive tools with read hints and scopes thread operations to the caller",
  () => {
    let calledThread: string | null = null;
    const unused = Effect.die("unused in this test");
    const service = DriveService.of({
      baseUrl: "https://drive.otterware.app",
      status: unused,
      statusChanges: Stream.empty,
      connect: unused,
      disconnect: unused,
      syncAccount: () => unused,
      listFolders: Effect.succeed([]),
      listDocuments: () => unused,
      documentDetail: () => unused,
      readDocument: () => unused,
      createDocument: () => unused,
      updateDocument: () => unused,
      markViewed: () => unused,
      linkDocument: () => unused,
      unlinkDocument: () => unused,
      listThreadLinks: (threadId) =>
        Effect.sync(() => {
          calledThread = threadId;
          return [];
        }),
      linkChanges: Stream.empty,
      changedDocuments: unused,
      requestSync: unused,
      syncNow: unused,
      start: unused,
    });
    const layer = suiteToolkitRegistration(DriveToolkit, layerHandlers).pipe(
      Layer.provide(Layer.succeed(DriveService, service)),
      Layer.provideMerge(McpServer.McpServer.layer),
    );
    const client = McpSchema.McpServerClient.of({
      clientId: 1,
      clientCapabilities: {},
      clientInfo: { name: "drive-test", version: "1" },
      protocolVersion: "2025-06-18",
      initializePayload: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "drive-test", version: "1" },
      },
      getClient: unused,
    });
    const caller: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("drive-test"),
      requestNamespace: "drive-test",
      issuedAt: 1,
      thread: {
        threadId: ThreadId.make("thread-drive"),
        providerSessionId: "test",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["suite"]),
    };
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
        "drive_create_document",
        "drive_get_document",
        "drive_link_document_to_thread",
        "drive_list_documents",
        "drive_list_folders",
        "drive_list_thread_documents",
        "drive_read_document",
        "drive_unlink_document_from_thread",
        "drive_update_document",
      ]);
      for (const { tool } of server.tools) {
        const readOnly =
          tool.name.startsWith("drive_list_") ||
          ["drive_get_document", "drive_read_document"].includes(tool.name);
        expect(tool.annotations?.readOnlyHint).toBe(readOnly);
      }
      const call = (scope: McpInvocationContext.McpInvocationScope) =>
        server
          .callTool({ name: "drive_list_thread_documents", arguments: {} })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      expect((yield* call(caller)).isError).toBe(false);
      expect(calledThread).toBe("thread-drive");
      expect((yield* call({ ...caller, thread: undefined })).isError).toBe(true);
      expect((yield* call({ ...caller, capabilities: new Set() })).isError).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer));
  },
);
