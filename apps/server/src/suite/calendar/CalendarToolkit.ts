/**
 * Otter Calendar's agent tools (vendored `mcp/toolkits/calendar/`), offered in every Code thread.
 * Upstream serves them to its own agent only, so they do not check MCP capabilities; here each
 * handler first requires the `suite` capability of the calling credential.
 */
import { CalendarError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { suiteToolkitRegistration } from "../mcpRegistration.ts";

import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import { CalendarHandlersLive } from "../../mcp/toolkits/calendar/handlers.ts";
import { CalendarToolkit } from "../../mcp/toolkits/calendar/tools.ts";

/**
 * Fails like a calendar error (the tools' declared failure, so the agent reads the reason)
 * unless the caller holds `suite`. The MCP server provides the invocation context to every
 * handler call; the vendored tools just do not declare it.
 */
export const requireSuiteCapability = Effect.serviceOption(McpInvocationContext).pipe(
  Effect.flatMap((invocation) =>
    Option.isSome(invocation) && invocation.value.capabilities.has("suite")
      ? Effect.void
      : Effect.fail(
          new CalendarError({
            code: "unavailable",
            detail: "Calendar tools need an Otterware credential with the suite capability.",
          }),
        ),
  ),
);

interface HandlerEntry {
  readonly handler: (params: unknown, context: unknown) => Effect.Effect<unknown, CalendarError>;
}

/** The vendored handlers, each behind `requireSuiteCapability`. */
export const layerHandlers = Layer.effectContext(
  Effect.map(Layer.build(CalendarHandlersLive), (built) => {
    const entries = new Map(built.mapUnsafe);
    for (const tool of Object.values(CalendarToolkit.tools)) {
      const entry = entries.get(tool.id) as HandlerEntry | undefined;
      if (entry === undefined) continue;
      entries.set(tool.id, {
        ...entry,
        handler: (params: unknown, context: unknown) =>
          requireSuiteCapability.pipe(Effect.andThen(entry.handler(params, context))),
      });
    }
    return Context.makeUnsafe(entries) as typeof built;
  }),
);

export const layer = suiteToolkitRegistration(CalendarToolkit, layerHandlers);
