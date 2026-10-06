import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as DeviceService from "../../device/DeviceService.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
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
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as SuiteServer from "../SuiteServer.ts";
import { SuiteHomeContributors } from "../SuiteModule.ts";
import { MailService } from "./MailService.ts";
import { mailAccessFor } from "./MailToolkit.ts";

// The demo mailbox: a fake Gmail inside Mail's worker, no Google account.
process.env.OTTER_MAIL_FAKE_DEMO = "1";

const layerStubServices = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: () => Effect.succeed({ runtimeMode: "approval-required" } as never),
  }),
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

const ToolsList = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          annotations: Schema.optional(
            Schema.Struct({
              readOnlyHint: Schema.optional(Schema.Boolean),
              destructiveHint: Schema.optional(Schema.Boolean),
            }),
          ),
        }),
      ),
    }),
  }),
);
const ToolCall = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      isError: Schema.optional(Schema.Boolean),
      content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
    }),
  }),
);
const firstJson = (body: string) => body.match(/\{.*\}/s)?.[0] ?? body;

it("gives threads without full access Mail's undoable tools only", () => {
  expect(mailAccessFor("full-access")).toBe("full-access");
  expect(mailAccessFor("approval-required")).toBe("safe");
  expect(mailAccessFor("auto-accept-edits")).toBe("safe");
});

it.effect(
  "an agent in a thread lists Mail's tools over /mcp and reads the demo mailbox; Home lists and archives",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const layerRoutes = McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer));
        const suiteContext = yield* HttpRouter.serve(layerRoutes, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed("environment-mail" as never),
            }),
          ),
          Layer.provideMerge(SuiteServer.layer),
          Layer.provide(PreviewAutomationBroker.layer),
          Layer.provide(PreviewBrowser.layer),
          Layer.provide(layerStubServices),
          Layer.build,
        );

        const credential = yield* McpSessionRegistry.issueActiveMcpCredential({
          threadId: ThreadId.make("thread-mail"),
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
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mail","version":"1.0.0"}}}`,
        );
        const sessionId = init.headers["mcp-session-id"];

        const list = yield* post(
          `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
          sessionId,
        );
        const tools = (yield* Schema.decodeUnknownEffect(ToolsList)(firstJson(yield* list.text)))
          .result.tools;
        const byName = new Map(tools.map((tool) => [tool.name, tool]));
        expect(byName.get("mail_search_mail")?.annotations?.readOnlyHint).toBe(true);
        expect(byName.get("mail_send_email")?.annotations?.destructiveHint).toBe(true);
        expect(byName.has("mail_save_view")).toBe(true);
        expect(byName.has("mail_list_projects")).toBe(true);
        // The Calendar module owns calendar tools, Otter Code owns themes.
        expect(byName.has("mail_list_events")).toBe(false);
        expect(byName.has("mail_use_theme")).toBe(false);

        const call = (id: number, name: string, args: object) =>
          post(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name, arguments: args },
            }),
            sessionId,
          ).pipe(
            Effect.flatMap((response) => response.text),
            Effect.flatMap((text) => Schema.decodeUnknownEffect(ToolCall)(firstJson(text))),
          );
        const accounts = yield* call(3, "mail_list_accounts", {});
        expect(accounts.result.isError ?? false).toBe(false);
        expect(accounts.result.content[0]?.text).toContain("demo@otter.example");
        // The thread runs with approvals, so Mail's permanent tools are not its to use.
        const send = yield* call(4, "mail_send_email", { to: "a@b.example", subject: "x" });
        expect(send.result.isError).toBe(true);

        const mail = yield* MailService.pipe(Effect.provideContext(suiteContext));
        // Listing the inbox waits for the fake Gmail to fill it, as opening Mail would.
        yield* mail.invoke({
          clientId: "test",
          channel: "gmail:listMessages",
          params: { accountId: "demo@otter.example", labelIds: ["INBOX"] },
        });
        const [contributor] = (yield* SuiteHomeContributors.pipe(
          Effect.provideContext(suiteContext),
        )).filter((entry) => entry.module === "mail");
        const items = yield* contributor!.needsYou;
        const reply = items.find(
          (item) => item.kind === "mail.reply" && item.id.includes("demo@otter.example"),
        );
        expect(reply?.target).toMatchObject({ route: "/mail" });
        expect(reply?.target.params?.at).toMatch(/^\/demo@otter\.example\/INBOX\//);

        yield* contributor!.performAction!(reply!.id, "archive");
        const after = yield* contributor!.needsYou;
        expect(after.some((item) => item.id === reply!.id)).toBe(false);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeHttpServer.layerTest,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-suite-mail-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          NodeServices.layer,
        ),
      ),
    ),
);
