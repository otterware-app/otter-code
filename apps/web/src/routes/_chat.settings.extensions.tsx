import { createFileRoute } from "@tanstack/react-router";

import { ExtensionsSettingsPanel } from "../components/settings/ExtensionsSettings";

export const Route = createFileRoute("/_chat/settings/extensions")({
  component: ExtensionsSettingsPanel,
});
