import { createFileRoute } from "@tanstack/react-router";

import { ProjectGroupsSettings } from "../components/settings/ProjectGroupsSettings";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { FoldersIcon } from "../lib/icons";

function SpacesPage() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <FoldersIcon className="size-4 text-muted-foreground" />
          <h1 className="text-sm font-medium">Spaces</h1>
        </WorkspacePageHeader>
        <ProjectGroupsSettings />
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/spaces")({ component: SpacesPage });
