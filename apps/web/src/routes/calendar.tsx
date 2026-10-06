import { createFileRoute } from "@tanstack/react-router";

import { requireSuiteRouteAuth } from "../suite/routeGuards";
import { SuiteModuleLayout } from "../suite/SuiteModuleLayout";
import { SuiteModulePlaceholder } from "../suite/SuiteModulePlaceholder";

function CalendarRoute() {
  return (
    <SuiteModuleLayout moduleId="calendar">
      <SuiteModulePlaceholder
        moduleId="calendar"
        description="Your calendars and today’s events, where agents can plan with you."
      />
    </SuiteModuleLayout>
  );
}

export const Route = createFileRoute("/calendar")({
  beforeLoad: requireSuiteRouteAuth,
  component: CalendarRoute,
});
