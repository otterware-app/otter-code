import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { CalendarService } from "../../calendar/CalendarService.ts";
import * as ServerConfig from "../../config.ts";
import * as DeviceService from "../../device/DeviceService.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { type McpCapability, McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { ServerActivation } from "../../serverActivation.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import { suiteAgentInstructions } from "../agentInstructions.ts";
import * as SuiteDatabase from "../SuiteDatabase.ts";
import { SuiteHomeContributors, SuiteRegistry } from "../SuiteModule.ts";
import * as SuiteServer from "../SuiteServer.ts";
import { requireSuiteCapability } from "./CalendarToolkit.ts";

// The upstream toolkits merged beside the suite's resolve these lazily.
const layerStubServices = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
);

const ListResult = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
  }),
);
const CallResult = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      isError: Schema.optional(Schema.Boolean),
      structuredContent: Schema.Unknown,
    }),
  }),
);
const AccountsResult = Schema.Struct({
  accounts: Schema.Array(Schema.Struct({ email: Schema.String })),
});

const decodeListResult = Schema.decodeUnknownEffect(ListResult);
const decodeCallResult = Schema.decodeUnknownEffect(CallResult);
const decodeAccountsResult = Schema.decodeUnknownEffect(AccountsResult);

const firstJson = (body: string) => body.match(/\{.*\}/s)?.[0] ?? body;

const CALENDAR_TOOLS = [
  "calendar_list_accounts",
  "calendar_list_events",
  "calendar_search_events",
  "calendar_get_event",
  "calendar_create_event",
  "calendar_update_event",
  "calendar_delete_event",
  "calendar_respond_to_invitation",
  "calendar_find_free_time",
];

describe("Calendar module", () => {
  // The production module includes the demo provider's simulated network latency.
  it.live("runs in the suite: capabilities, migrations, agent tools over /mcp and Home", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const activation = yield* Deferred.make<void>();
        const parked = yield* Deferred.make<void>();
        const layerRoutes = McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer));
        const suite = yield* HttpRouter.serve(layerRoutes, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed("environment-calendar" as never),
            }),
          ),
          Layer.provideMerge(SuiteServer.layer),
          Layer.provide(
            Layer.succeed(
              ServerActivation,
              Deferred.succeed(parked, undefined).pipe(Effect.andThen(Deferred.await(activation))),
            ),
          ),
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(PreviewAutomationBroker.layer),
          Layer.provide(PreviewBrowser.layer),
          Layer.provide(layerStubServices),
          Layer.build,
        );

        const registry = yield* SuiteRegistry.pipe(Effect.provideContext(suite));
        // Calendar's services finish building while account sync waits for activation.
        yield* Deferred.await(parked);
        expect(yield* Deferred.isDone(activation)).toBe(false);
        expect((yield* registry.capabilities).modules).toContain("calendar");
        const sql = yield* SuiteDatabase.SuiteSqlClient.pipe(Effect.provideContext(suite));
        const applied = yield* sql<{ readonly module: string; readonly id: number }>`
          SELECT module, id FROM suite_migrations
        `;
        expect(applied.map((row) => `${row.module}#${row.id}`)).toContain("calendar#1");
        expect(suiteAgentInstructions()).toContain("calendar_find_free_time");

        const calendar = yield* CalendarService.pipe(Effect.provideContext(suite));
        yield* calendar.addDemo({ size: "standard" });
        yield* calendar.sync({});
        const directory = yield* calendar.getDirectory;
        const writable = directory.calendars.find((entry) => entry.accessRole === "owner")!;
        const now = yield* Clock.currentTimeMillis;
        const created = yield* calendar.createEvent({
          calendarId: writable.calendarId,
          title: "Suite Home integration event",
          time: {
            allDay: false,
            start: new Date(now).toISOString(),
            end: new Date(now + 60_000).toISOString(),
          },
        });

        const credential = yield* McpSessionRegistry.issueActiveMcpCredential({
          threadId: ThreadId.make("thread-calendar"),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        });
        const httpClient = yield* HttpClient.HttpClient;
        const post = (body: string, sessionId?: string) =>
          httpClient.post("/mcp", {
            headers: {
              accept: "application/json, text/event-stream",
              authorization: credential!.config.authorizationHeader,
              "mcp-protocol-version": "2025-06-18",
              ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            },
            body: HttpBody.text(body, "application/json"),
          });
        const init = yield* post(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"calendar","version":"1.0.0"}}}`,
        );
        const sessionId = init.headers["mcp-session-id"];

        const list = yield* post(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`, sessionId);
        const listed = yield* decodeListResult(firstJson(yield* list.text));
        const names = listed.result.tools.map((tool) => tool.name);
        for (const tool of CALENDAR_TOOLS) expect(names).toContain(tool);

        const call = yield* post(
          `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"calendar_list_accounts","arguments":{}}}`,
          sessionId,
        );
        const called = yield* decodeCallResult(firstJson(yield* call.text));
        expect(called.result.isError ?? false).toBe(false);
        const accounts = yield* decodeAccountsResult(called.result.structuredContent);
        expect(accounts.accounts.length).toBeGreaterThan(0);

        const contributors = yield* SuiteHomeContributors.pipe(Effect.provideContext(suite));
        const home = contributors.find((contributor) => contributor.module === "calendar");
        expect(home?.today).toBeDefined();
        expect(yield* home!.today!).toContainEqual(
          expect.objectContaining({
            title: "Suite Home integration event",
            id: `${writable.calendarId}/${created.event!.eventId}`,
          }),
        );
        yield* Deferred.succeed(activation, undefined);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeHttpServer.layerTest,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-suite-calendar-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          NodeServices.layer,
        ),
      ),
    ),
  );

  it.effect("refuses MCP callers without the suite capability", () =>
    Effect.gen(function* () {
      const scope = {
        environmentId: EnvironmentId.make("environment-calendar"),
        issuedAt: 0,
        requestNamespace: "test",
        thread: undefined,
        client: { sessionId: "client", label: "Outside agent", runtimeModeCeiling: "auto" },
      } as const;
      const refused = yield* requireSuiteCapability.pipe(
        Effect.provideService(McpInvocationContext, {
          ...scope,
          capabilities: new Set<McpCapability>(),
        }),
        Effect.flip,
      );
      expect(refused.code).toBe("unavailable");
      yield* requireSuiteCapability.pipe(
        Effect.provideService(McpInvocationContext, {
          ...scope,
          capabilities: new Set(["suite"] as const),
        }),
      );
      // No invocation at all (not an MCP call) is refused too.
      expect((yield* Effect.flip(requireSuiteCapability)).code).toBe("unavailable");
    }),
  );
});
