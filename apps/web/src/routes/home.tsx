import { createFileRoute, Outlet } from "@tanstack/react-router";

import { HomeSidebar } from "../suite/home/HomeSidebar";
import { requireSuiteRouteAuth } from "../suite/routeGuards";
import { SuiteModuleLayout } from "../suite/SuiteModuleLayout";

function HomeLayout() {
  return (
    <SuiteModuleLayout moduleId="home" sidebar={<HomeSidebar />} sideChat={false}>
      <Outlet />
    </SuiteModuleLayout>
  );
}

export const Route = createFileRoute("/home")({
  beforeLoad: requireSuiteRouteAuth,
  component: HomeLayout,
});
