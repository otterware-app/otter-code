/**
 * Builds the Otterware suite from the module registry and exposes it to the
 * upstream server through three requirement-free hooks, so the upstream files
 * each change by one line:
 *
 * - `layer` joins the runtime dependencies in `server.ts`.
 * - `layerRpcHandlers` joins each WebSocket connection's handlers in `ws.ts`.
 * - `layerMcpToolkits` joins the MCP toolkits in `mcp/McpHttpServer.ts`.
 *
 * Without `SuiteRuntime` in context (tests that build those graphs alone) the
 * two hooks contribute nothing.
 */
import { SUITE_PROTOCOL_VERSION, SuiteRpcGroup, type SuiteRpcTag } from "@t3tools/contracts/suite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import { setSuiteAgentInstructions } from "./agentInstructions.ts";
import { SUITE_SERVER_MODULES } from "./modules.ts";
import * as SuiteDatabase from "./SuiteDatabase.ts";
import { runSuiteMigrations } from "./SuiteMigrations.ts";
import { SuiteHomeContributors, SuiteRegistry, type SuiteServerModule } from "./SuiteModule.ts";

type Module = (typeof SUITE_SERVER_MODULES)[number];
type FieldOf<M, K extends PropertyKey> = M extends unknown
  ? K extends keyof M
    ? Exclude<M[K], undefined>
    : never
  : never;
type ModuleHandlersLayer = FieldOf<Module, "rpcHandlers">;
type ModuleToolkitLayer = FieldOf<Module, "mcpToolkit">;

type SuiteRpcs = RpcGroup.Rpcs<typeof SuiteRpcGroup>;
type HandledTag<H> = H extends Rpc.Handler<infer Tag> ? Tag : never;
type UnhandledSuiteRpc = Exclude<SuiteRpcs["_tag"], HandledTag<Layer.Success<ModuleHandlersLayer>>>;
// Every RPC listed in packages/contracts/src/suite/index.ts needs a module
// whose `rpcHandlers` serves it; a missing one names itself here.
const allSuiteRpcsHandled: [UnhandledSuiteRpc] extends [never] ? true : UnhandledSuiteRpc = true;
void allSuiteRpcsHandled;

type SuiteRpcHandlers = Rpc.ToHandler<SuiteRpcs>;
type ToolkitServices = Exclude<Layer.Services<ModuleToolkitLayer>, SuiteHomeContributors>;

/** What the hooks below read; built once per server. */
export class SuiteRuntime extends Context.Service<
  SuiteRuntime,
  {
    readonly rpcHandlers: Context.Context<SuiteRpcHandlers>;
    /** Module services and the server runtime, for registering MCP toolkits. */
    readonly toolkitContext: Context.Context<ToolkitServices | SuiteHomeContributors>;
  }
>()("t3/suite/SuiteServer/SuiteRuntime") {}

/** One optional field of every registered module that sets it, with the registry's precise types. */
const moduleFields = <K extends keyof SuiteServerModule>(key: K) =>
  SUITE_SERVER_MODULES.map((module: SuiteServerModule) => module[key]).filter(
    (value) => value !== undefined,
  ) as unknown as Array<FieldOf<Module, K>>;

/** `Layer.mergeAll` over a runtime list, keeping the registry's precise types. */
const mergeLayers = <L extends Layer.Any>(
  layers: ReadonlyArray<L>,
): Layer.Layer<Layer.Success<L>, Layer.Error<L>, Layer.Services<L>> => {
  const [first, ...rest] = layers as unknown as ReadonlyArray<Layer.Layer<never>>;
  const merged = first === undefined ? Layer.empty : Layer.mergeAll(first, ...rest);
  return merged as unknown as Layer.Layer<Layer.Success<L>, Layer.Error<L>, Layer.Services<L>>;
};

const moduleIds = SUITE_SERVER_MODULES.map((module) => module.id);

const layerRegistry = Layer.succeed(SuiteRegistry, {
  moduleIds,
  capabilities: Effect.succeed({ modules: moduleIds, suiteVersion: SUITE_PROTOCOL_VERSION }),
});

const layerMigrations = Layer.effectDiscard(
  runSuiteMigrations(SUITE_SERVER_MODULES.flatMap((module) => module.migrations)),
).pipe(Layer.provide(SuiteDatabase.layerSqlClient));

const layerModules = mergeLayers(moduleFields("layer"));
const layerRpcHandlerBuild = mergeLayers(moduleFields("rpcHandlers"));
const toolkitLayers = moduleFields("mcpToolkit");

const makeRuntime = Effect.gen(function* () {
  const contributors = yield* Effect.all(moduleFields("homeContributor"));
  const rpcHandlers = yield* Layer.build(layerRpcHandlerBuild).pipe(
    Effect.provideService(SuiteHomeContributors, contributors),
  );
  // Typed with the toolkits' requirements so a module whose tools need a
  // service nobody provides fails `server.ts`'s typecheck, not at runtime.
  const runtimeContext = yield* Effect.context<ToolkitServices>();
  setSuiteAgentInstructions(moduleFields("agentInstructions"));
  yield* Effect.logInfo("Otterware suite ready", { modules: moduleIds });
  return Context.make(SuiteHomeContributors, contributors).pipe(
    Context.add(SuiteRuntime, {
      rpcHandlers,
      toolkitContext: Context.add(runtimeContext, SuiteHomeContributors, contributors),
    }),
  );
});

/**
 * Opens `suite.sqlite`, runs suite migrations, then builds every module.
 * Outputs the module services, so the rest of the server can use them too.
 */
export const layer = Layer.effectContext(makeRuntime).pipe(
  Layer.provideMerge(layerModules.pipe(Layer.provide(layerMigrations))),
  Layer.provideMerge(Layer.merge(layerRegistry, SuiteDatabase.layer)),
);

const readRuntime = Effect.serviceOption(SuiteRuntime);

/** Every suite RPC's handler, for `RpcServer.make(WsRpcGroup)` in `ws.ts`. */
export const layerRpcHandlers = Layer.unwrap(
  Effect.map(
    readRuntime,
    Option.match({
      onNone: () => Layer.empty,
      onSome: (runtime) => Layer.succeedContext(runtime.rpcHandlers),
    }),
  ),
) as Layer.Layer<Rpc.ToHandler<SuiteRpcs>>;

/** Every module's MCP toolkit, merged next to the upstream toolkits. */
export const layerMcpToolkits: Layer.Layer<never> = Layer.unwrap(
  Effect.map(
    readRuntime,
    Option.match({
      onNone: () => Layer.empty,
      onSome: (runtime) =>
        mergeLayers(toolkitLayers).pipe(
          Layer.provide(Layer.succeedContext(runtime.toolkitContext)),
        ),
    }),
  ),
);

/** The suite RPC tags, for omitting them from the upstream handler object. */
export type { SuiteRpcTag };
