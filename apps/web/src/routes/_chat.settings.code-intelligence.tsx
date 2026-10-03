import { createFileRoute } from "@tanstack/react-router";

import { CodeIntelligenceSettingsPanel } from "../components/settings/CodeIntelligenceSettings";

export const Route = createFileRoute("/_chat/settings/code-intelligence")({
  component: CodeIntelligenceSettingsPanel,
});
