import * as Layer from "effect/Layer";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- Suite/vendor compatibility adapter; handlers retain their existing capability checks.
import { McpServer, type Tool, type Toolkit } from "effect/ai";
import type { McpInvocationContext } from "../mcp/McpInvocationContext.ts";

/**
 * The suite keeps the vendored handler layers and their own capability checks.
 * Like McpHttpServer.toolkitRegistration, registration must not capture the
 * invocation context that the HTTP middleware supplies separately for each call.
 */
export const suiteToolkitRegistration = <Tools extends Record<string, Tool.Any>, E, R>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: Layer.Layer<Tool.HandlersFor<Tools>, E, R>,
) => {
  // oxlint-disable-next-line t3code/no-raw-mcp-registration -- Compatibility adapter for suite/vendor handlers, which retain their capability checks.
  const registration = McpServer.toolkit(toolkit);
  // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off -- The authenticated transport provides this per request, never at registration.
  const requestScoped = registration as Layer.Layer<
    never,
    never,
    Exclude<Layer.Services<typeof registration>, McpInvocationContext>
  >;
  return requestScoped.pipe(Layer.provide(handlers));
};
