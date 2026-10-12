import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { SUITE_CORE_METHODS, type SuiteCapabilities } from "@t3tools/contracts/suite";

import { connectionAtomRuntime } from "../connection/runtime";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";

const suiteCapabilitiesQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:suite:capabilities",
  tag: SUITE_CORE_METHODS.capabilities,
  staleTimeMs: 5 * 60_000,
  idleTtlMs: 10 * 60_000,
});

export type SuiteCapabilitiesState =
  | { readonly status: "loading" }
  /** The environment is a plain Otter Code server (or unreachable): no suite. */
  | { readonly status: "unavailable" }
  | { readonly status: "available"; readonly capabilities: SuiteCapabilities };

/**
 * Whether the primary environment is an Otterware server, and which modules
 * it runs. Remote environments may be plain Otter Code, which does not know
 * `suite.capabilities`; pages degrade to an empty state then.
 */
export function useSuiteCapabilities(): SuiteCapabilitiesState {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : suiteCapabilitiesQuery({ environmentId, input: {} }),
  );
  if (query.data !== null) return { status: "available", capabilities: query.data };
  if (environmentId === null || query.error === null) return { status: "loading" };
  return { status: "unavailable" };
}

export function suiteHasModule(state: SuiteCapabilitiesState, module: string | null): boolean {
  return (
    module === null || (state.status === "available" && state.capabilities.modules.includes(module))
  );
}
