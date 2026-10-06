/**
 * Otterware suite contracts. Each module adds its contract file in this folder
 * and ONE line to `mergeSuiteContracts` below; `rpc.ts` merges the result into
 * `WsRpcGroup`, so web, desktop and mobile get typed clients for free.
 */
import { mergeSuiteContracts, type SuiteRpcTag } from "./contract.ts";
import { SuiteCoreContract } from "./core.ts";
import { SuiteDriveContract } from "./drive.ts";

export * from "./contract.ts";
export * from "./core.ts";
export * from "./drive.ts";
export * from "./home.ts";

const SuiteContracts = mergeSuiteContracts(
  SuiteCoreContract,
  SuiteDriveContract,
  // SuiteMailContract,
);

export const SuiteRpcGroup = SuiteContracts.group;
export const SUITE_RPC_REQUIRED_SCOPES = SuiteContracts.scopes;
export const SUITE_RPC_TAGS = Object.keys(SUITE_RPC_REQUIRED_SCOPES) as ReadonlyArray<
  keyof typeof SUITE_RPC_REQUIRED_SCOPES & SuiteRpcTag
>;
