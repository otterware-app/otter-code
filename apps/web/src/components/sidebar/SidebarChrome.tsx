import { ArrowLeftIcon, ChevronDownIcon } from "lucide-react";
import { memo, useCallback, type ComponentProps, type ReactNode, type RefObject } from "react";
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
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";

/**
 * The sidebar's first row, which names the space it shows (`children`: its
 * heading). There's no wordmark, as in Otter Mail. The dev and nightly stage
 * art sits behind the row. In the desktop app's frame the title band above
 * the panel stays empty for the window controls and the pinned toggle, so
 * the row is the panel's first; in a browser tab it shares the band, after
 * the toggle.
 */
export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
  headingRef,
  children,
}: {
  isElectron: boolean;
  /** The heading's row, for a popup to anchor to its width. */
  headingRef?: RefObject<HTMLDivElement | null>;
  children?: ReactNode;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;
  const inPanel = useAppFrame() === "window";

  return (
    <>
      {inPanel ? (
        <div aria-hidden className="drag-region h-(--workspace-topbar-height) shrink-0" />
      ) : null}
      {/* The titlebar row, not a padded SidebarHeader: it aligns to the window controls. */}
      <div
        className={cn(
          "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 px-3 md:pl-0",
          isElectron && !inPanel && "drag-region",
        )}
        data-stage-art={backdropVariant ? "" : undefined}
      >
        {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
        <SidebarTrigger
          // Over the stage artwork: the media viewer's control-on-imagery treatment.
          variant={backdropVariant ? "media-navigation" : "ghost"}
          className="relative top-auto z-10 translate-y-0 md:hidden"
        />
        {/* One visible line: the pill wraps onto the clipped second line once it no longer fits.
            The padding keeps the heading's focus ring inside the clip. */}
        <div
          ref={headingRef}
          className="relative z-10 ms-(--sidebar-heading-start) flex h-9 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5"
        >
          {children}
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
}: { title: string } & Omit<ComponentProps<"button">, "children">) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "group/space-heading flex h-8 min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left text-lg font-semibold tracking-tight text-sidebar-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 data-[popup-open]:bg-sidebar-row-hover in-data-stage-art:text-white",
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

// Settings, Usage and Pull Requests live in the space rail; their pages
// offer Back here, to the thread they were opened over.
export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });

  const handleBackClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigateToMainApp();
  }, [isMobile, navigateToMainApp, setOpenMobile]);

  return (
    <SidebarMenu className="flex-row items-center">
      {isOnUtilityPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : null}
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter>
      <SidebarThreadUndoNotice />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
