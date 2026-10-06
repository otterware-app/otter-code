/**
 * The frame of every Otterware module page: the module's own sidebar, its
 * main content, and the side chat slot on the right. The Code thread sidebar
 * is hidden on these routes (AppSidebarLayout); the rail stays.
 */
import { PanelRightOpenIcon } from "lucide-react";
import type { ReactNode } from "react";

import { isElectron } from "../env";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { SUITE_WEB_MODULES } from "./modules";
import { SuiteModuleUnavailable } from "./SuiteModuleUnavailable";
import { SuiteSideChatSlot, useSuiteSideChatOpen } from "./SuiteSideChatSlot";
import { suiteHasModule, useSuiteCapabilities } from "./useSuiteCapabilities";

export function SuiteModuleLayout({
  moduleId,
  sidebar,
  headerActions,
  children,
}: {
  readonly moduleId: string;
  /** The module's own navigation (folders, calendars, ...), left of the content. */
  readonly sidebar?: ReactNode;
  readonly headerActions?: ReactNode;
  readonly children: ReactNode;
}) {
  const module = SUITE_WEB_MODULES.find((entry) => entry.id === moduleId);
  const capabilities = useSuiteCapabilities();
  const [sideChatOpen, setSideChatOpen] = useSuiteSideChatOpen();
  const available = module !== undefined && suiteHasModule(capabilities, module.serverModule);
  const label = module?.label ?? moduleId;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1" data-suite-module={moduleId}>
        {available && sidebar ? (
          <nav
            aria-label={label}
            className="flex w-60 shrink-0 flex-col border-r border-border bg-background"
          >
            <div className="h-(--workspace-topbar-height) shrink-0" />
            <div className="min-h-0 flex-1 overflow-y-auto">{sidebar}</div>
          </nav>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
          <WorkspacePageHeader electron={isElectron}>
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{label}</h1>
            {headerActions}
            {sideChatOpen ? null : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Show side chat"
                      onClick={() => setSideChatOpen(true)}
                    />
                  }
                >
                  <PanelRightOpenIcon />
                </TooltipTrigger>
                <TooltipPopup side="bottom">Show side chat</TooltipPopup>
              </Tooltip>
            )}
          </WorkspacePageHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {available || capabilities.status === "loading" ? (
              children
            ) : (
              <SuiteModuleUnavailable
                label={label}
                plainServer={capabilities.status === "unavailable"}
              />
            )}
          </div>
        </div>
        <SuiteSideChatSlot />
      </div>
    </SidebarInset>
  );
}
