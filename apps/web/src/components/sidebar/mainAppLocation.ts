import type { ScopedThreadRef } from "@t3tools/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { resolveThreadRouteRef } from "~/threadRoutes";
import { isSuiteModulePath } from "~/suite/modules";

// Settings, Usage, and Pull Requests replace the sidebar utility row with a
// Back button. Everything else is the main app. Legacy `/projects/<key>` links
// redirect into settings, so they count too and are never remembered.
export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/projects/") ||
    pathname === "/usage" ||
    pathname === "/pull-requests" ||
    isSuiteModulePath(pathname)
  );
}

let mainAppHref: string | null = null;
let lastThreadRef: ScopedThreadRef | null = null;

// Mount once in the app shell. Records the latest main app URL so Back can
// return there no matter how many utility pages were visited since.
export function MainAppLocationTracker() {
  const href = useLocation({
    select: (location) => (isSidebarUtilityPage(location.pathname) ? null : location.href),
  });
  const { environmentId, threadId } = useParams({ strict: false });
  useEffect(() => {
    if (href !== null) mainAppHref = href;
  }, [href]);
  useEffect(() => {
    lastThreadRef = resolveThreadRouteRef({ environmentId, threadId }) ?? lastThreadRef;
  }, [environmentId, threadId]);
  return null;
}

/** The thread last open in the main app, for a utility page to open something beside. */
export function lastMainAppThreadRef(): ScopedThreadRef | null {
  return lastThreadRef;
}

// Leaves a utility page for the last main app URL, or the thread list when
// the app was opened directly on a utility page.
export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return useCallback(() => navigate({ href: mainAppHref ?? "/" }), [navigate]);
}
