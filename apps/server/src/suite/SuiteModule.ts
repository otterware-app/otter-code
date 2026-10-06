/**
 * What an Otterware module hands the server. A module lives in its own folder
 * under `apps/server/src/suite/<module>/`, exports one `SuiteServerModule`
 * built with `defineSuiteServerModule`, and is registered with ONE line in
 * `./modules.ts`.
 */
import type {
  SuiteCapabilities,
  SuiteHomeActionError,
  SuiteHomeItem,
  SuiteHomeItemModule,
  SuiteTodayEvent,
} from "@t3tools/contracts/suite";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

import type { SuiteMigration } from "./SuiteMigrations.ts";

/**
 * Feeds Home. Registered through a module's `homeContributor`. Home calls it on
 * every overview (clients poll while Home is open), so reads must be cheap:
 * serve from the module's own tables or a short cache, never a network call.
 */
export interface SuiteHomeContributor {
  readonly module: SuiteHomeItemModule;
  /** Items that currently need the user, newest or most urgent first. Handles its own failures. */
  readonly needsYou: Effect.Effect<ReadonlyArray<SuiteHomeItem>>;
  /** Today's events for Home's calendar strip (the calendar module). Handles its own failures. */
  readonly today?: Effect.Effect<ReadonlyArray<SuiteTodayEvent>>;
  readonly performAction?: (
    itemId: string,
    actionId: string,
  ) => Effect.Effect<void, SuiteHomeActionError>;
}

export interface SuiteServerModule {
  /** `mail`, `calendar`, `drive`, `home`, ... Also the migration namespace. */
  readonly id: string;
  /** Applied to `suite.sqlite` before any module layer is built. */
  readonly migrations: ReadonlyArray<SuiteMigration>;
  /**
   * The module's services, built once per server. Module tables live in
   * `suite.sqlite`: provide `SuiteDatabase.layerSqlClient` locally to code
   * written against a plain `SqlClient`. Background loops should wait for
   * server activation (`ServerActivation.forkParked`).
   */
  readonly layer?: Layer.Layer<never, unknown, unknown>;
  /**
   * `<Module>RpcGroup.toLayer(...)` for the module's contract in
   * `packages/contracts/src/suite/`. Built once per server with the module
   * services and `SuiteHomeContributors` available; handlers only decode,
   * call a service method and map errors.
   */
  readonly rpcHandlers?: Layer.Layer<never, never, unknown>;
  /**
   * `McpServer.toolkit(<Module>Toolkit).pipe(Layer.provide(handlers))`. Tools
   * are offered to agents in every Code thread; handlers check
   * `McpInvocationContext.requireMcpCapability("suite")`.
   */
  readonly mcpToolkit?: Layer.Layer<never, never, unknown>;
  /** Appended to every provider's runtime instructions when non-empty. */
  readonly agentInstructions?: string;
  /** Built once per server in the module's context. */
  readonly homeContributor?: Effect.Effect<SuiteHomeContributor, never, unknown>;
}

/** Keeps a module's precise layer types so the registry can check them. */
export const defineSuiteServerModule = <const M extends SuiteServerModule>(module: M): M => module;

/** The registered modules, for code that reports on them. */
export class SuiteRegistry extends Context.Service<
  SuiteRegistry,
  {
    readonly moduleIds: ReadonlyArray<string>;
    readonly capabilities: Effect.Effect<SuiteCapabilities>;
  }
>()("t3/suite/SuiteModule/SuiteRegistry") {}

/** Every module's Home contributor, for the Home module's handlers and tools. */
export class SuiteHomeContributors extends Context.Service<
  SuiteHomeContributors,
  ReadonlyArray<SuiteHomeContributor>
>()("t3/suite/SuiteModule/SuiteHomeContributors") {}
