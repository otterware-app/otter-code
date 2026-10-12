import { createFileRoute } from "@tanstack/react-router";

import { requireSuiteRouteAuth } from "../suite/routeGuards";

/** `?url=` opens a Drive document (Home items, thread links). */
function validateDriveSearch(search: Record<string, unknown>): { url?: string } {
  return typeof search.url === "string" && search.url.length > 0 ? { url: search.url } : {};
}

function DriveRoute() {
  // The app shell owns the retained list/native view.
  return null;
}

export const Route = createFileRoute("/drive")({
  validateSearch: validateDriveSearch,
  beforeLoad: requireSuiteRouteAuth,
  component: DriveRoute,
});
