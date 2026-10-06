import { createFileRoute } from "@tanstack/react-router";

import { requireSuiteRouteAuth } from "../suite/routeGuards";
import { SuiteModuleLayout } from "../suite/SuiteModuleLayout";
import { SuiteModulePlaceholder } from "../suite/SuiteModulePlaceholder";

function DriveRoute() {
  return (
    <SuiteModuleLayout moduleId="drive">
      <SuiteModulePlaceholder
        moduleId="drive"
        description="Your files and documents, ready to hand to an agent."
      />
    </SuiteModuleLayout>
  );
}

export const Route = createFileRoute("/drive")({
  beforeLoad: requireSuiteRouteAuth,
  component: DriveRoute,
});
