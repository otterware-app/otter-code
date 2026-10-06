/**
 * The suite's own module: `suite.capabilities` over RPC and MCP, and a small
 * key/value table for suite preferences (the shared server `settings.json`
 * must not gain Otterware keys, see OTTERWARE.md).
 */
import { SuiteCoreRpcGroup, SUITE_CORE_METHODS } from "@t3tools/contracts/suite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";
import * as SqlClient from "effect/sql/SqlClient";

import { defineSuiteServerModule, SuiteRegistry } from "../SuiteModule.ts";
import * as SuiteCoreToolkit from "./SuiteCoreToolkit.ts";

const rpcHandlers = SuiteCoreRpcGroup.toLayer(
  Effect.gen(function* () {
    const registry = yield* SuiteRegistry;
    return SuiteCoreRpcGroup.of({
      [SUITE_CORE_METHODS.capabilities]: () => registry.capabilities,
    });
  }),
);

export const SuiteCoreModule = defineSuiteServerModule({
  id: "core",
  migrations: [
    {
      module: "core",
      id: 1,
      name: "suite_core_kv",
      run: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          CREATE TABLE suite_core_kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `;
      }),
    },
  ],
  rpcHandlers,
  mcpToolkit: McpServer.toolkit(SuiteCoreToolkit.SuiteCoreToolkit).pipe(
    Layer.provide(SuiteCoreToolkit.layerHandlers),
  ),
  agentInstructions: `## Otterware

This Otter Code server is part of Otterware. \`suite_capabilities\` lists the modules it runs (mail, calendar, drive, ...). Module tools are available in every thread; use them when the user asks about their mail, calendar or files.`,
});
