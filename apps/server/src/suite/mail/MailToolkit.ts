/**
 * Mail's agent tools in every Code thread's MCP server, registered from the
 * list core reports at startup (`MailService.listTools`), so a tool Mail adds
 * upstream needs no change here. Names get a `mail_` prefix (`mail_search_mail`)
 * beside the other modules' tools. A thread's access follows its runtime mode:
 * full access may send and delete for good, anything else gets Mail's "safe"
 * tools (changes that can be undone).
 */
import type { RuntimeMode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { MailService } from "./MailService.ts";
import type { MailToolCaller, MailToolDescriptor } from "./worker/protocol.ts";

export const MAIL_TOOL_PREFIX = "mail_";

export const mailToolName = (name: string) => `${MAIL_TOOL_PREFIX}${name}`;

/** Mail's access for a runtime mode: full access, or Mail's undoable "safe" set. */
export const mailAccessFor = (mode: RuntimeMode): MailToolCaller["access"] =>
  mode === "full-access" ? "full-access" : "safe";

const textResult = (text: string, isError: boolean) =>
  new McpSchema.CallToolResult({ isError, content: [{ type: "text", text }] });

/** The MCP tool for one of Mail's: its JSON Schema as is, hints from `readOnly`/`permanent`. */
export const mailMcpTool = (tool: MailToolDescriptor) =>
  new McpSchema.Tool({
    name: mailToolName(tool.name),
    title: tool.title,
    description: tool.description,
    inputSchema: tool.input as McpSchema.Tool["inputSchema"],
    annotations: {
      title: tool.title,
      readOnlyHint: tool.readOnly,
      destructiveHint: tool.permanent,
      idempotentHint: tool.readOnly,
      openWorldHint: true,
    },
  });

const resolveCaller = Effect.fn("mail.resolveToolCaller")(function* (
  scope: McpInvocationContext.McpInvocationScope,
) {
  if (scope.thread === undefined) {
    return {
      key: `client:${scope.client?.sessionId ?? scope.requestNamespace}`,
      access: mailAccessFor(scope.client?.runtimeModeCeiling ?? "approval-required"),
    } satisfies MailToolCaller;
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* threads
    .getThreadShell(scope.thread.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  return {
    key: `thread:${scope.thread.threadId}`,
    access: mailAccessFor(shell?.runtimeMode ?? "approval-required"),
  } satisfies MailToolCaller;
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const mail = yield* MailService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const tools = yield* mail.listTools.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Mail's agent tools are unavailable", { cause: error.message }).pipe(
          Effect.as([] as ReadonlyArray<MailToolDescriptor>),
        ),
      ),
    );
    for (const tool of tools) {
      yield* server.addTool({
        tool: mailMcpTool(tool),
        annotations: Context.empty(),
        handle: (payload) =>
          Effect.withFiber((fiber) => {
            const invocation = Context.getUnsafe(
              fiber.context,
              McpInvocationContext.McpInvocationContext,
            );
            return McpInvocationContext.requireMcpCapability("suite").pipe(
              Effect.flatMap(resolveCaller),
              Effect.flatMap((caller) =>
                mail.callTool(
                  caller,
                  tool.name,
                  payload !== null && typeof payload === "object"
                    ? (payload as Record<string, unknown>)
                    : {},
                ),
              ),
              Effect.map(({ text, isError }) => textResult(text, isError)),
              Effect.catch((error) => Effect.succeed(textResult(error.message, true))),
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.provideService(ThreadManagement.ThreadManagementService, threads),
            );
          }),
      });
    }
    yield* Effect.logDebug("Mail's agent tools registered", { count: tools.length });
  }),
  // The same memoized server the MCP transport serves (as `McpServer.toolkit` does).
).pipe(Layer.provide(McpServer.McpServer.layer));
