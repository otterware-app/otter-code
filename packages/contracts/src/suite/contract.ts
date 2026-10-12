import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import type { AuthEnvironmentScope } from "../auth.ts";

/** Every suite RPC is namespaced `suite.<module>.<name>` (core: `suite.<name>`). */
export type SuiteRpcTag = `suite.${string}`;

/**
 * One module's wire surface: its RPC group plus the scope each RPC needs.
 * A missing scope is a type error, the same guarantee `RPC_REQUIRED_SCOPES`
 * gives the upstream methods.
 */
export interface SuiteContract<R extends Rpc.Any> {
  readonly group: RpcGroup.RpcGroup<R>;
  readonly scopes: { readonly [Tag in R["_tag"]]: AuthEnvironmentScope };
}

export const defineSuiteContract = <R extends Rpc.Any & { readonly _tag: SuiteRpcTag }>(
  contract: SuiteContract<R>,
): SuiteContract<R> => contract;

/** Merges the module contracts listed in `./index.ts` into one group and one scope table. */
export const mergeSuiteContracts = <const Rs extends readonly [Rpc.Any, ...Array<Rpc.Any>]>(
  ...contracts: { readonly [K in keyof Rs]: SuiteContract<Rs[K]> }
): SuiteContract<Rs[number]> => {
  const [first, ...rest] = contracts as unknown as ReadonlyArray<SuiteContract<Rs[number]>>;
  return {
    group: first!.group.merge(...rest.map((contract) => contract.group)),
    scopes: Object.assign({}, ...contracts.map((contract) => contract.scopes)),
  };
};
