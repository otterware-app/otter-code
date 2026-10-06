import { createFileRoute } from "@tanstack/react-router";

import { requireSuiteRouteAuth } from "../suite/routeGuards";
import { SuiteModuleLayout } from "../suite/SuiteModuleLayout";
import { SuiteModulePlaceholder } from "../suite/SuiteModulePlaceholder";

function HomeRoute() {
  return (
    <SuiteModuleLayout moduleId="home">
      <SuiteModulePlaceholder
        moduleId="home"
        description="Your day across Code, Mail, Calendar and Drive: what needs you, and what’s next."
      />
    </SuiteModuleLayout>
  );
}

export const Route = createFileRoute("/home")({
  beforeLoad: requireSuiteRouteAuth,
  component: HomeRoute,
});
