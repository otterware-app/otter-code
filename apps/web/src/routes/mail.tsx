import { createFileRoute } from "@tanstack/react-router";

import { requireSuiteRouteAuth } from "../suite/routeGuards";
import { SuiteModuleLayout } from "../suite/SuiteModuleLayout";
import { SuiteModulePlaceholder } from "../suite/SuiteModulePlaceholder";

function MailRoute() {
  return (
    <SuiteModuleLayout moduleId="mail">
      <SuiteModulePlaceholder
        moduleId="mail"
        description="Your inbox, with agents that can read, sort and draft replies."
      />
    </SuiteModuleLayout>
  );
}

export const Route = createFileRoute("/mail")({
  beforeLoad: requireSuiteRouteAuth,
  component: MailRoute,
});
