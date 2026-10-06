/**
 * Otterware suite contracts. Each module adds its contract file in this folder
 * and ONE line to `mergeSuiteContracts` below; `rpc.ts` merges the result into
 * `WsRpcGroup`, so web, desktop and mobile get typed clients for free.
 */
import {
  SuiteCalendarContract,
  type SuiteCalendarStreamCommandRpcTag,
  type SuiteCalendarSubscriptionRpcTag,
} from "./calendar.ts";
import { mergeSuiteContracts, type SuiteRpcTag } from "./contract.ts";
import { SuiteCoreContract } from "./core.ts";
import { SUITE_DRIVE_METHODS, SuiteDriveContract } from "./drive.ts";
import { SUITE_MAIL_METHODS, SuiteMailContract } from "./mail.ts";
import { SuiteHomeContract } from "./home.ts";

export * from "./calendar.ts";
export * from "./contract.ts";
export * from "./core.ts";
export * from "./drive.ts";
export * from "./home.ts";
export * from "./mail.ts";

const SuiteContracts = mergeSuiteContracts(
  SuiteCoreContract,
  SuiteCalendarContract,
  SuiteDriveContract,
  SuiteMailContract,
  SuiteHomeContract,
);

export const SuiteRpcGroup = SuiteContracts.group;
export const SUITE_RPC_REQUIRED_SCOPES = SuiteContracts.scopes;
export const SUITE_RPC_TAGS = Object.keys(SUITE_RPC_REQUIRED_SCOPES) as ReadonlyArray<
  keyof typeof SUITE_RPC_REQUIRED_SCOPES & SuiteRpcTag
>;

/**
 * Suite streaming RPCs, by how clients consume them (joined into `client-runtime`'s
 * `EnvironmentSubscriptionRpcTag` and `EnvironmentStreamCommandRpcTag`). A module with streams
 * adds its tags here.
 */
export type SuiteSubscriptionRpcTag =
  | SuiteCalendarSubscriptionRpcTag
  | typeof SUITE_DRIVE_METHODS.subscribeStatus
  | typeof SUITE_DRIVE_METHODS.subscribeThreadLinks
  | typeof SUITE_MAIL_METHODS.events;
export type SuiteStreamCommandRpcTag = SuiteCalendarStreamCommandRpcTag;
