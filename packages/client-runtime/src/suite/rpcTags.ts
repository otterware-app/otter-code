/** Suite streams join the existing subscription machinery as modules register their RPCs. */
import type * as Stream from "effect/Stream";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";

type SuiteTag = keyof WsRpcProtocolClient & `suite.${string}`;
export type SuiteSubscriptionRpcTag = {
  [Tag in SuiteTag]: ReturnType<WsRpcProtocolClient[Tag]> extends Stream.Stream<
    unknown,
    unknown,
    never
  >
    ? Tag
    : never;
}[SuiteTag];
