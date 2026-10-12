import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "../auth.ts";
import { defineSuiteContract } from "./contract.ts";

/**
 * Bumped when a client needs to tell suite servers apart. A plain Otter Code
 * server does not answer `suite.capabilities` at all.
 */
export const SUITE_PROTOCOL_VERSION = 1;

export const SUITE_CORE_METHODS = {
  capabilities: "suite.capabilities",
} as const;

export const SuiteCapabilities = Schema.Struct({
  /** Ids of the server modules registered in `apps/server/src/suite/modules.ts`. */
  modules: Schema.Array(Schema.String),
  suiteVersion: Schema.Int,
});
export type SuiteCapabilities = typeof SuiteCapabilities.Type;

const SuiteCapabilitiesRpc = Rpc.make(SUITE_CORE_METHODS.capabilities, {
  payload: Schema.Struct({}),
  success: SuiteCapabilities,
  error: EnvironmentAuthorizationError,
});

export const SuiteCoreRpcGroup = RpcGroup.make(SuiteCapabilitiesRpc);

export const SuiteCoreContract = defineSuiteContract({
  group: SuiteCoreRpcGroup,
  scopes: {
    [SUITE_CORE_METHODS.capabilities]: AuthOrchestrationReadScope,
  },
});
