import { McpCapabilityUnavailableError } from "@t3tools/contracts";
import { SuiteCapabilities } from "@t3tools/contracts/suite";
import * as Effect from "effect/Effect";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { SuiteRegistry } from "../SuiteModule.ts";

const SuiteCapabilitiesTool = Tool.make("suite_capabilities", {
  description:
    "List the Otterware modules (mail, calendar, drive, ...) this Otter Code server runs. Their tools are only available when the module is listed.",
  success: SuiteCapabilities,
  failure: McpCapabilityUnavailableError,
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "List Otterware modules")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const SuiteCoreToolkit = Toolkit.make(SuiteCapabilitiesTool);

export const layerHandlers = SuiteCoreToolkit.toLayer(
  Effect.gen(function* () {
    const registry = yield* SuiteRegistry;
    return SuiteCoreToolkit.of({
      suite_capabilities: () =>
        McpInvocationContext.requireMcpCapability("suite").pipe(
          Effect.andThen(registry.capabilities),
        ),
    });
  }),
);
