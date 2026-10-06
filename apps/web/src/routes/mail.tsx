import { createFileRoute } from "@tanstack/react-router";

import { MailFrame } from "../suite/mail/MailFrame";
import { requireSuiteRouteAuth } from "../suite/routeGuards";
import { SuiteModuleLayout } from "../suite/SuiteModuleLayout";

/** `?at=` is Mail's own route (`/<mailbox>/<label>/<conversation>`, `/settings/<pane>`). */
type MailSearch = { readonly at?: string };

function MailRoute() {
  const { at } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SuiteModuleLayout moduleId="mail">
      <MailFrame
        at={at}
        onNavigate={(path) => void navigate({ search: { at: path }, replace: true })}
      />
    </SuiteModuleLayout>
  );
}

export const Route = createFileRoute("/mail")({
  beforeLoad: requireSuiteRouteAuth,
  validateSearch: (search: Record<string, unknown>): MailSearch =>
    typeof search.at === "string" && search.at.startsWith("/") ? { at: search.at } : {},
  component: MailRoute,
});
