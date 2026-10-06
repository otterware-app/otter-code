/**
 * The rail of spaces down the window's left edge (Otter Mail's, ChatGPT's):
 * All projects, then each project, the + that adds one, then Pull requests;
 * Usage and Settings at its foot. A project space scopes the thread sidebar
 * (the same `sidebarProjectScopeKey` its heading's picker sets). The rail
 * stays when the sidebar hides, and sits inside the sheet on phones.
 */
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChartNoAxesColumnIcon, LayersIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { memo, useMemo, type ReactNode } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useClientSettings, useLegacySidebarEnabled } from "../../hooks/useSettings";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../../logicalProject";
import { cn } from "../../lib/utils";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useProjects } from "../../state/entities";
import {
  useEnvironmentIdentities,
  usePrimaryEnvironmentId,
  usePullRequestsSupported,
} from "../../state/environments";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import { orderItemsByPreferredIds } from "../Sidebar.logic";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";

/** A rail button: a square that lights up on hover, and stays lit where you are. */
const RAIL_BUTTON =
  "relative flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-sidebar-muted-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 [-webkit-app-region:no-drag]";
const RAIL_BUTTON_SELECTED = "bg-sidebar-row-selected text-sidebar-foreground";

type RailPlace = "settings" | "usage" | "pull-requests" | "threads";

function railPlace(pathname: string): RailPlace {
  if (pathname === "/usage") return "usage";
  if (pathname === "/pull-requests") return "pull-requests";
  return isSidebarUtilityPage(pathname) ? "settings" : "threads";
}

function RailButton({
  label,
  selected = false,
  onClick,
  children,
}: {
  label: string;
  selected?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-current={selected ? "page" : undefined}
            onClick={onClick}
            className={cn(RAIL_BUTTON, selected && RAIL_BUTTON_SELECTED)}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

function RailDivider() {
  return <span aria-hidden className="my-1 h-px w-5 shrink-0 bg-sidebar-border" />;
}

/**
 * The project spaces, in the user's manual project order: a rail keeps its
 * places, so it never re-sorts by activity the way the thread list can.
 */
function useRailProjectGroups() {
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environments = useEnvironmentIdentities();
  return useMemo(() => {
    const labelById = new Map(
      environments.map((environment) => [environment.environmentId, environment.label] as const),
    );
    return buildSidebarProjectSnapshots({
      projects: orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
      settings: projectGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => labelById.get(environmentId) ?? null,
    });
  }, [environments, primaryEnvironmentId, projectGroupingSettings, projectOrder, projects]);
}

export const SpaceRail = memo(function SpaceRail({ className }: { className?: string }) {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, open, setOpen, setOpenMobile } = useSidebar();
  const place = useLocation({ select: (location) => railPlace(location.pathname) });
  const pullRequestsSupported = usePullRequestsSupported();
  // The legacy sidebar groups threads by project itself and ignores the scope.
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const projectGroups = useRailProjectGroups();
  const scopeKey = useUiStateStore((store) => store.sidebarProjectScopeKey);
  const setScopeKey = useUiStateStore((store) => store.setSidebarProjectScopeKey);

  const leaveSheet = () => {
    if (isMobile) setOpenMobile(false);
  };
  // A space's threads show in the sidebar, so choosing one brings it back,
  // and leaves a utility page for the thread it was opened over.
  const selectSpace = (projectKey: string | null) => {
    setScopeKey(projectKey);
    if (!isMobile && !open) void setOpen(true);
    if (place !== "threads") void navigateToMainApp();
  };
  const threadsShowing = place === "threads";

  return (
    <nav
      aria-label="Spaces"
      data-app-sidebar=""
      data-space-rail=""
      className={cn(
        "flex w-(--workspace-rail-width) shrink-0 flex-col items-center pb-(--sidebar-content-inset) text-sidebar-foreground",
        className,
      )}
    >
      {/* The desktop window's title band: the traffic lights sit over it. */}
      <div
        aria-hidden
        className="drag-region hidden h-(--workspace-topbar-height) w-full shrink-0 in-data-[app-frame=window]:block"
      />
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto pt-(--space-rail-top) [scrollbar-width:none]">
        {legacySidebarEnabled ? null : (
          <>
            <RailButton
              label="All projects"
              selected={threadsShowing && scopeKey === null}
              onClick={() => selectSpace(null)}
            >
              <LayersIcon className="size-5" />
            </RailButton>
            {projectGroups.map((group) => (
              <RailButton
                key={group.projectKey}
                label={group.displayName}
                selected={threadsShowing && scopeKey === group.projectKey}
                onClick={() => selectSpace(group.projectKey)}
              >
                {/* Wrapped so the button's color can't override a project's own icon color. */}
                <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md">
                  <ProjectFavicon project={group} className="size-5" />
                </span>
              </RailButton>
            ))}
          </>
        )}
        <RailButton
          label="Add project"
          onClick={() => {
            leaveSheet();
            openCommandPalette({ open: "add-project" });
          }}
        >
          <PlusIcon className="size-4.5" />
        </RailButton>
        {pullRequestsSupported ? (
          <>
            <RailDivider />
            <RailButton
              label="Pull requests"
              selected={place === "pull-requests"}
              onClick={() => {
                leaveSheet();
                void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
              }}
            >
              <PullRequestGlyph.pullRequest className="size-4.5" />
            </RailButton>
          </>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1 pt-1">
        <RailButton
          label="Usage"
          selected={place === "usage"}
          onClick={() => {
            leaveSheet();
            void navigate({ to: "/usage" });
          }}
        >
          <ChartNoAxesColumnIcon className="size-4.5" />
        </RailButton>
        <RailButton
          label="Settings"
          selected={place === "settings"}
          onClick={() => {
            leaveSheet();
            void navigate({ to: "/settings" });
          }}
        >
          <SettingsIcon className="size-4.5" />
        </RailButton>
      </div>
    </nav>
  );
});
