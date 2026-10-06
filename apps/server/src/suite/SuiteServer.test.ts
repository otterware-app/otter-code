import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { SuiteProject, SuiteHomeOverview } from "@t3tools/contracts/suite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { suiteAgentInstructions } from "./agentInstructions.ts";
import * as SuiteDatabase from "./SuiteDatabase.ts";
import * as SuiteServer from "./SuiteServer.ts";

// The upstream toolkits merged beside the suite's resolve these lazily; the
// suite tool under test needs none of them.
const layerStubServices = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
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

const JsonRpcResult = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({ tools: Schema.optional(Schema.Array(Schema.Unknown)) }),
  }),
);
const ToolNames = Schema.Array(Schema.Struct({ name: Schema.String }));
const CallResult = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      isError: Schema.optional(Schema.Boolean),
      structuredContent: Schema.Struct({
        modules: Schema.Array(Schema.String),
        suiteVersion: Schema.Number,
      }),
    }),
  }),
);

const HomeCallResult = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      isError: Schema.optional(Schema.Boolean),
      structuredContent: Schema.Struct({ contributors: Schema.Array(Schema.Unknown) }),
    }),
  }),
);

const decodeJsonRpcResult = Schema.decodeUnknownEffect(JsonRpcResult);
const decodeHomeResult = Schema.decodeUnknownEffect(HomeCallResult);
const decodeToolNames = Schema.decodeUnknownEffect(ToolNames);
const decodeCallResult = Schema.decodeUnknownEffect(CallResult);

const decodeProject = Schema.decodeUnknownEffect(SuiteProject);
const decodeOverview = Schema.decodeUnknownEffect(SuiteHomeOverview);
const decodeProjectList = Schema.decodeUnknownEffect(
  Schema.Struct({
    projects: Schema.Array(Schema.Struct({ project: SuiteProject })),
  }),
);
const decodeToolResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        isError: Schema.optional(Schema.Boolean),
        structuredContent: Schema.Unknown,
      }),
    }),
  ),
);

const firstJson = (body: string) => body.match(/\{.*\}/s)?.[0] ?? body;

it.effect("an agent in a thread lists and calls suite_capabilities over /mcp", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const layerRoutes = McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer));
      const suiteContext = yield* HttpRouter.serve(layerRoutes, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed("environment-suite" as never),
          }),
        ),
        Layer.provideMerge(SuiteServer.layer),
        Layer.provide(PreviewAutomationBroker.layer),
        Layer.provide(PreviewBrowser.layer),
        Layer.provide(layerStubServices),
        Layer.build,
      );

      const credential = yield* McpSessionRegistry.issueActiveMcpCredential({
        threadId: ThreadId.make("thread-suite"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      });
      const authorization = credential!.config.authorizationHeader;
      const httpClient = yield* HttpClient.HttpClient;
      const post = (body: string, sessionId?: string) =>
        httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization,
            "mcp-protocol-version": "2025-06-18",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: HttpBody.text(body, "application/json"),
        });

      const init = yield* post(
        `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"suite","version":"1.0.0"}}}`,
      );
      expect(init.status).toBe(200);
      const sessionId = init.headers["mcp-session-id"];

      const list = yield* post(
        `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
        sessionId,
      );
      const listed = yield* decodeJsonRpcResult(firstJson(yield* list.text));
      const names = (yield* decodeToolNames(listed.result.tools)).map((tool) => tool.name);
      expect(names).toContain("suite_capabilities");
      expect(names).toContain("suite_home_overview");
      expect(names).toContain("suite_create_project");
      // Merged beside the upstream toolkits, not instead of them.
      expect(names).toContain("delegate_task");

      const call = yield* post(
        `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"suite_capabilities","arguments":{}}}`,
        sessionId,
      );
      const called = yield* decodeCallResult(firstJson(yield* call.text));
      expect(called.result.isError ?? false).toBe(false);
      expect(called.result.structuredContent.modules).toContain("core");
      expect(called.result.structuredContent.modules).toContain("home");

      // Home answers even when Code's projections cannot be read (stubbed here).
      const home = yield* post(
        `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"suite_home_overview","arguments":{}}}`,
        sessionId,
      );
      const homeResult = yield* decodeHomeResult(firstJson(yield* home.text));
      expect(homeResult.result.isError ?? false).toBe(false);
      expect(homeResult.result.structuredContent.contributors).toEqual([
        { module: "code", ok: false, itemCount: 0 },
      ]);

      const callTool = (name: string, args: unknown) =>
        Effect.gen(function* () {
          const response = yield* post(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 5,
              method: "tools/call",
              params: { name, arguments: args },
            }),
            sessionId,
          );
          return yield* decodeToolResult(firstJson(yield* response.text));
        });
      const created = yield* callTool("suite_create_project", {
        name: "Acme",
        rules: { mail: { domains: ["acme.com"] } },
      });
      expect(created.result.isError ?? false).toBe(false);
      const project = yield* decodeProject(created.result.structuredContent);
      expect(project.rules.mail.domains).toEqual(["acme.com"]);
      const updated = yield* callTool("suite_update_project", {
        id: project.id,
        name: "Acme rollout",
      });
      const renamed = yield* decodeProject(updated.result.structuredContent);
      expect(renamed.name).toBe("Acme rollout");
      expect(renamed.rules).toEqual(project.rules);
      const projectOverview = yield* callTool("suite_get_project_overview", {
        projectId: project.id,
      });
      const scoped = yield* decodeOverview(projectOverview.result.structuredContent);
      expect(scoped.projects[0]?.project.id).toBe(project.id);
      const projectList = yield* callTool("suite_list_projects", {});
      const listedProjects = yield* decodeProjectList(projectList.result.structuredContent);
      expect(listedProjects.projects.map((entry) => entry.project.name)).toEqual(["Acme rollout"]);

      // Module migrations ran in suite.sqlite, beside (not inside) the main database.
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(
        yield* fs.exists(path.join(config.stateDir, SuiteDatabase.SUITE_DATABASE_FILENAME)),
      ).toBe(true);
      const sql = yield* SuiteDatabase.SuiteSqlClient.pipe(Effect.provideContext(suiteContext));
      const applied = yield* sql<{ readonly module: string; readonly id: number }>`
        SELECT module, id FROM suite_migrations
      `;
      expect(applied.map((row) => `${row.module}#${row.id}`)).toContain("core#1");
      expect(applied.map((row) => `${row.module}#${row.id}`)).toContain("home#1");
      expect(suiteAgentInstructions()).toContain("suite_capabilities");
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-suite-mcp-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
  ),
);
