import { ArrowLeftIcon, ChevronDownIcon } from "lucide-react";
import { memo, type ComponentProps, type ReactNode, type RefObject } from "react";
import { useLocation } from "@tanstack/react-router";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { useAppFrame } from "./appFrame";
import { useActiveProjectSpace } from "../../hooks/useProjectSpace";
import { openCommandPalette } from "../../commandPaletteBus";
import { SearchIcon } from "../../lib/icons";
import { Button } from "../ui/button";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning } from "./SidebarUpdatePill";
/**
 * The sidebar's first row, naming its space (`children`), with stage art behind it. In the
 * desktop frame the title band stays clear for window controls and the pinned toggle; in a
 * browser tab the row shares the band, after the toggle.
 */
export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
  headingRef,
  onSearch,
  children,
}: {
  isElectron: boolean;
  /** The heading's row, for a popup to anchor to its width. */
  headingRef?: RefObject<HTMLDivElement | null>;
  onSearch?: () => void;
  children?: ReactNode;
}) {
  const inPanel = useAppFrame() === "window";
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    inPanel ? "none" : environmentIdentificationMode,
  );
  const pillLabel =
    !inPanel && environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;
  const { space } = useActiveProjectSpace();
  const showThreadActions = useLocation({
    select: (location) => !isSidebarUtilityPage(location.pathname),
  });

  return (
    <>
      {inPanel ? (
        <div aria-hidden className="drag-region h-(--workspace-topbar-height) shrink-0" />
      ) : null}
      {/* The titlebar row, not a padded SidebarHeader: it aligns to the window controls. */}
      <div
        className={cn(
          "relative flex h-11 shrink-0 flex-row items-center gap-1 px-2",
          isElectron && !inPanel && "drag-region",
        )}
        data-stage-art={backdropVariant ? "" : undefined}
      >
        {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
        {/* Match the fixed control's inset and border compensation inside the sheet's safe area. */}
        <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
          <SidebarTrigger
            // Over the stage artwork: the media viewer's control-on-imagery treatment.
            variant={backdropVariant ? "media-navigation" : "ghost"}
            className="relative top-auto translate-y-0"
            aria-label="Toggle main sidebar"
          />
        </div>
        <div
          ref={headingRef}
          className="relative z-10 ms-(--sidebar-heading-start) flex h-9 min-w-0 flex-1 items-center gap-x-2 overflow-hidden py-0.5"
        >
          <div className="min-w-0 flex-1">
            {children ?? <SidebarSpaceTitle>{space.name}</SidebarSpaceTitle>}
          </div>
          {showThreadActions ? (
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Search"
                onClick={onSearch ?? (() => openCommandPalette())}
              >
                <SearchIcon className="size-4" />
              </Button>
            </div>
          ) : null}
          {pillLabel ? (
            <div className="ml-1 flex h-8 items-center">
              <Badge data-environment-identification="pill" size="sm" variant="secondary">
                {pillLabel}
              </Badge>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
});
/** A sidebar's heading (Otter Mail's): the space it shows, large. */
export function SidebarSpaceTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="min-w-0 truncate px-(--sidebar-row-content-inset) text-lg font-semibold tracking-tight text-sidebar-foreground in-data-stage-art:text-white">
      {children}
    </h2>
  );
}
/**
 * The space's heading as the project picker's trigger: its name, with a
 * chevron that shows on hover or while the picker is open. Spreads unknown
 * props through so a popup trigger can inject its handlers, ref and aria state.
 */
export function SidebarSpaceHeading({
  title,
  className,
  ...rest
}: {
  title: string;
} & Omit<ComponentProps<"button">, "children">) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "group/space-heading flex h-8 min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left text-lg font-semibold tracking-tight text-sidebar-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset data-[popup-open]:bg-sidebar-row-hover in-data-stage-art:text-white",
        className,
      )}
    >
      <span className="min-w-0 truncate">{title}</span>
      <ChevronDownIcon
        aria-hidden
        className="size-4 shrink-0 text-sidebar-muted-foreground opacity-0 group-hover/space-heading:opacity-100 group-focus-visible/space-heading:opacity-100 group-data-[popup-open]/space-heading:opacity-100 in-data-stage-art:text-white/70"
      />
    </button>
  );
}
// Settings, Usage, Pull Requests and updates live in the space rail; their pages
// offer Back here, to the thread they were opened over.
export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const handleBackClick = () => {
    if (isMobile) setOpenMobile(false);
    void navigateToMainApp();
  };
  if (!isOnUtilityPage) return null;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={handleBackClick}>
          <ArrowLeftIcon />
          <span>Back</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter>
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
