import { createFileRoute } from "@tanstack/react-router";

import { requireSuiteRouteAuth } from "../suite/routeGuards";

/** `?at=` is Mail's own route (`/<mailbox>/<label>/<conversation>`, `/settings/<pane>`). */
type MailSearch = { readonly at?: string };

// The app shell owns the persistent frame, including its URL mirroring.
function MailRoute() {
  return null;
}

export const Route = createFileRoute("/mail")({
  beforeLoad: requireSuiteRouteAuth,
  validateSearch: (search: Record<string, unknown>): MailSearch =>
    typeof search.at === "string" && search.at.startsWith("/") ? { at: search.at } : {},
  component: MailRoute,
});
