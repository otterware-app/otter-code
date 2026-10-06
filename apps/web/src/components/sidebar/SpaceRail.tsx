/**
 * The rail of spaces down the window's left edge (Otter Mail's, ChatGPT's):
 * All projects, Chats, then each project group (made in Settings), then Pull
 * requests; the desktop app's update button, Usage and Settings at its foot.
 * A space scopes the thread sidebar and the projects new threads are offered
 * in. The rail stays when the sidebar hides, and sits inside the sheet on
 * phones.
 */
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChartNoAxesColumnIcon, LayersIcon, MessagesSquareIcon, SettingsIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { useLegacySidebarEnabled } from "../../hooks/useSettings";
import { useProjectGroups } from "../../hooks/useProjectSpace";
import { cn } from "../../lib/utils";
import { deriveProjectIdentity } from "../../projectIdentity";
import { CHATS_SPACE_ID, resolveProjectSpace } from "../../projectSpaces";
import { usePullRequestsSupported } from "../../state/environments";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectMonogram } from "../ProjectMonogram";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

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

export const SpaceRail = memo(function SpaceRail({ className }: { className?: string }) {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, open, setOpen, setOpenMobile } = useSidebar();
  const place = useLocation({ select: (location) => railPlace(location.pathname) });
  const pullRequestsSupported = usePullRequestsSupported();
  // The legacy sidebar groups threads by project itself and ignores the scope.
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const { groups } = useProjectGroups();
  const storedSpaceId = useUiStateStore((store) => store.sidebarProjectSpaceId);
  const setSpaceId = useUiStateStore((store) => store.setSidebarProjectSpaceId);
  // A deleted group's id resolves to All projects, so that one lights up.
  const spaceId = resolveProjectSpace(storedSpaceId, groups).id;

  const leaveSheet = () => {
    if (isMobile) setOpenMobile(false);
  };
  // A space's threads show in the sidebar, so choosing one brings it back,
  // and leaves a utility page for the thread it was opened over.
  const selectSpace = (nextSpaceId: string | null) => {
    setSpaceId(nextSpaceId);
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
              selected={threadsShowing && spaceId === null}
              onClick={() => selectSpace(null)}
            >
              <LayersIcon className="size-5" />
            </RailButton>
            <RailButton
              label="Chats"
              selected={threadsShowing && spaceId === CHATS_SPACE_ID}
              onClick={() => selectSpace(CHATS_SPACE_ID)}
            >
              <MessagesSquareIcon className="size-5" />
            </RailButton>
            {groups.map((group) => {
              const identity = deriveProjectIdentity(group.name);
              return (
                <RailButton
                  key={group.id}
                  label={group.name}
                  selected={threadsShowing && spaceId === group.id}
                  onClick={() => selectSpace(group.id)}
                >
                  <ProjectMonogram
                    text={identity.monogram}
                    color={identity.color}
                    className="size-6"
                  />
                </RailButton>
              );
            })}
          </>
        )}
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
        <SidebarUpdatePill />
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
