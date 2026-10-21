import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { isElectron } from "../env";
import { getLocalStorageItem, removeLocalStorageItem } from "../hooks/useLocalStorage";
import {
  isRichTextBoldShortcut,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { cn, isMacPlatform } from "../lib/utils";
import { observeResize } from "../lib/observeResize";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useEnvironmentIdentificationMode } from "../hooks/useSettings";
import {
  PanelAnimationSuppressionProvider,
  usePanelAnimationSettings,
  usePanelNavigationSuppression,
} from "../panelAnimations";
import { useThreadVisitedMigration } from "../hooks/useThreadVisitedMigration";
import ThreadSidebar from "./Sidebar";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { SidebarChromeHeader, SidebarSpaceTitle } from "./sidebar/SidebarChrome";
import { MainAppLocationTracker } from "./sidebar/mainAppLocation";
import { SpaceRail } from "./sidebar/SpaceRail";
import { PersistentSuitePages } from "../suite/PersistentSuitePages";
import { isSuiteModulePath } from "../suite/modules";
import { useAppFrame } from "./sidebar/appFrame";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
  useSidebarStageBackdropVariant,
} from "./SidebarStageBackdrop";
import { useProjects } from "../state/entities";
import {
  clampThreadSidebarWidth,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "./threadSidebarWidth";
import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
  useSidebarVisibility,
} from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useThreadRouteRef } from "../hooks/useThreadRouteTarget";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { ArrowLeftIcon, ArrowRightIcon } from "../lib/icons";

const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "var(--desktop-window-controls-inset, 90px)";
/** The rail's width (appFrame.css's --workspace-rail-width). */
const SPACE_RAIL_WIDTH = 51;
/** Where the pinned sidebar toggle sits without traffic lights to clear: past the rail. */
const FRAMED_CONTROLS_LEFT =
  "calc(env(safe-area-inset-left, 0px) + env(titlebar-area-x, 0px) + var(--workspace-rail-width) + 0.75rem)";

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function readViewportWidth(): number {
  return window.innerWidth;
}

// getWindowFullscreenState is a synchronous IPC round trip, so the snapshot is cached
// and only re-read when a subscription starts.
let windowFullscreenSnapshot: boolean | null = null;

function macosDesktopBridge() {
  if (!isElectron || !isMacPlatform(navigator.platform)) return null;
  return window.desktopBridge ?? null;
}

function subscribeToWindowFullscreen(onChange: () => void): () => void {
  const bridge = macosDesktopBridge();
  if (
    typeof bridge?.getWindowFullscreenState !== "function" ||
    typeof bridge.onWindowFullscreenStateChange !== "function"
  ) {
    return () => {};
  }
  const unsubscribe = bridge.onWindowFullscreenStateChange((fullscreen) => {
    windowFullscreenSnapshot = fullscreen;
    onChange();
  });
  // The window may have changed state between the first render and this subscription.
  windowFullscreenSnapshot = bridge.getWindowFullscreenState();
  return () => {
    unsubscribe();
    windowFullscreenSnapshot = null;
  };
}

function readWindowFullscreen(): boolean {
  if (windowFullscreenSnapshot === null) {
    const getWindowFullscreenState = macosDesktopBridge()?.getWindowFullscreenState;
    windowFullscreenSnapshot =
      typeof getWindowFullscreenState === "function" ? getWindowFullscreenState() : false;
  }
  return windowFullscreenSnapshot;
}

function readInitialThreadSidebarWidth(): number {
  try {
    return resolveInitialThreadSidebarWidth(
      getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite),
      window.innerWidth,
    );
  } catch (error) {
    console.error("Could not read persisted thread sidebar width.", error);
    return resolveInitialThreadSidebarWidth(null, window.innerWidth);
  }
}

function SidebarControl({ onWidthChange }: { onWidthChange: (width: number) => void }) {
  const usagePageOpen = useLocation({ select: (location) => location.pathname === "/usage" });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar, isMobile, mobileSheetMounted } = useSidebar();
  const isSidebarVisible = useSidebarVisibility();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const stageBackdropVariant = useSidebarStageBackdropVariant(
    environmentIdentificationMode === "artwork",
  );
  // In the desktop app's frame the toggle sits on the title band, above the art.
  const frame = useAppFrame();
  const stageLabel = useEnvironmentStageLabel();
  const pillLabel =
    frame === "window" && environmentIdentificationMode !== "none"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;
  const [controlsElement, setControlsElement] = useState<HTMLDivElement | null>(null);
  const overArtwork = isSidebarVisible && stageBackdropVariant !== null && frame !== "window";
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle", {
    context: { usagePageOpen },
  });

  useLayoutEffect(() => {
    if (!controlsElement) return;
    const measure = () => onWidthChange(controlsElement.getBoundingClientRect().width);
    measure();
    return observeResize(controlsElement, measure);
  }, [controlsElement, onWidthChange]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (
        isRichTextBoldShortcut(event) &&
        event.target instanceof HTMLElement &&
        event.target.closest('[data-composer-rich-text="true"]')
      ) {
        // The rich-text composer claims Mod+B for bold; the toggle stays
        // available everywhere else, including the plain-text composer.
        return;
      }
      if (
        resolveShortcutCommand(event, keybindings, { context: { usagePageOpen } }) !==
        "sidebar.toggle"
      )
        return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    window.addEventListener("keydown", onKeyDown, true);
    const unsubscribe = window.desktopBridge?.onMenuAction((action) => {
      if (action === "sidebar.toggle") toggleSidebar();
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      unsubscribe?.();
    };
  }, [keybindings, toggleSidebar, usagePageOpen]);

  return (
    <div
      ref={setControlsElement}
      className={cn(
        "pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 ml-px flex h-[var(--workspace-topbar-height)] items-center",
        isMobile && mobileSheetMounted && "hidden",
      )}
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger
              // Over the stage artwork the trigger is a control on imagery, like the media
              // viewer's arrows; that variant positions itself, so the layout is reset here.
              variant={overArtwork ? "media-navigation" : "ghost"}
              className={cn(
                "pointer-events-auto",
                overArtwork && "relative top-auto translate-y-0",
              )}
              aria-label="Toggle main sidebar"
            />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      <div className="pointer-events-auto ml-1 hidden items-center gap-0.5 md:flex">
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label="Back"
          onClick={() => window.history.back()}
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label="Forward"
          onClick={() => window.history.forward()}
        >
          <ArrowRightIcon className="size-4" />
        </Button>
        {pillLabel ? (
          <div className="drag-region ml-2 flex items-center">
            <Badge data-environment-identification="pill" size="sm" variant="secondary">
              {pillLabel}
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NavigationHistoryShortcuts() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const routeThreadRef = useThreadRouteRef();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeThreadRef
            ? selectThreadTerminalUiState(
                useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
                routeThreadRef,
              ).terminalOpen
            : false,
          previewFocus: isPreviewFocused(),
          previewOpen: routeThreadRef
            ? selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, routeThreadRef) ===
              "preview"
            : false,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command !== "navigation.back" && command !== "navigation.forward") return;

      event.preventDefault();
      event.stopPropagation();
      if (command === "navigation.back") window.history.back();
      else window.history.forward();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, routeThreadRef]);

  return null;
}

// Settings swaps the thread sidebar out of the tree. Keep the lightweight
// project projection subscribed so returning to a draft never renders the
// zero-project state while the environment snapshot reconnects.
function ProjectProjectionRetention() {
  useProjects();
  return null;
}

/** On phones the sidebar is a sheet: the rail runs down its left edge. */
function MobileSpaceRailLayout({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  if (!enabled) return children;
  return (
    <div className="flex min-h-0 w-full flex-1">
      <SpaceRail className="border-r border-sidebar-border" />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/**
 * The content panel's rim and rounded corners, drawn over the panes so they
 * keep painting their own surfaces (appFrame.css).
 */
function AppFramePanelEdge() {
  return (
    <div aria-hidden data-app-panel-edge="">
      <div data-corner="top-left" />
      <div data-corner="top-right" />
      <div data-corner="bottom-left" />
      <div data-corner="bottom-right" />
      <div data-rim="" />
    </div>
  );
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  useThreadVisitedMigration();
  const pathname = useLocation({ select: (location) => location.pathname });
  const panelAnimationsSuppressed = usePanelNavigationSuppression(pathname);
  const routePanelAnimationsActive = panelAnimationsActive && !panelAnimationsSuppressed;
  const isOnSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  // Otter Mail's frame: the rail and one inset panel. Phones keep the sheet,
  // with the rail inside it.
  const frame = useAppFrame();
  const railWidth = frame ? SPACE_RAIL_WIDTH : 0;
  // Full-width pages: the rail is their way out, so phones (rail in the sheet) keep the sidebar.
  const sidebarHidden =
    frame !== null &&
    (pathname === "/usage" ||
      pathname === "/pull-requests" ||
      pathname === "/spaces" ||
      isSuiteModulePath(pathname));
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth);
  const [titlebarControlsWidth, setTitlebarControlsWidth] = useState<number | null>(null);
  // Subscribed rather than read once: the clamp must track live window size,
  // and a clamped drag ends with an unchanged width, which skips the re-render
  // that would otherwise refresh a render-time snapshot.
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const sidebarMinimumWidth = THREAD_SIDEBAR_MIN_WIDTH;
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(
    viewportWidth - railWidth,
    sidebarMinimumWidth,
  );
  const resetSidebarWidth = () => {
    try {
      removeLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY);
    } catch (error) {
      console.error("Could not clear persisted thread sidebar width.", error);
    }
    setSidebarWidth(resolveInitialThreadSidebarWidth(null, viewportWidth));
  };
  const isWindowFullscreen = useSyncExternalStore(
    subscribeToWindowFullscreen,
    readWindowFullscreen,
  );
  const windowControlsInsetStyle = (
    isMacosDesktop && !isWindowFullscreen
      ? { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : {}
  ) as CSSProperties;
  const sidebarContent = isOnSettings ? (
    <>
      <SidebarChromeHeader isElectron={isElectron}>
        <SidebarSpaceTitle>Settings</SidebarSpaceTitle>
      </SidebarChromeHeader>
      <SettingsSidebarNav pathname={pathname} />
    </>
  ) : (
    <ThreadSidebar />
  );
  const sidebarProviderStyle = {
    "--sidebar-width": `${clampThreadSidebarWidth(sidebarWidth, sidebarMinimumWidth, sidebarMaximumWidth)}px`,
    "--panel-animation-duration": `${panelAnimationDurationMs}ms`,
    ...(frame ? { "--workspace-controls-left": FRAMED_CONTROLS_LEFT } : {}),
    ...windowControlsInsetStyle,
    // Headers place their content after the pinned toggle, in their own
    // coordinates: the panes start after the rail.
    ...(frame
      ? {
          "--workspace-titlebar-controls-width":
            titlebarControlsWidth === null
              ? "calc(3 * var(--workspace-titlebar-control-size) + var(--workspace-titlebar-control-gap))"
              : `${titlebarControlsWidth}px`,
          "--workspace-titlebar-content-left":
            "calc(var(--workspace-controls-left) + var(--workspace-titlebar-controls-width) + 0.25rem - var(--workspace-rail-width))",
        }
      : {}),
  } as CSSProperties;

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        const isSettingsRoute = /^\/settings(\/|$)/.test(pathname);
        if (!isSettingsRoute) {
          void navigate({ to: "/settings" });
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, pathname]);

  return (
    <PanelAnimationSuppressionProvider value={panelAnimationsSuppressed}>
      <SidebarProvider
        className="h-dvh! min-h-0!"
        data-app-frame={frame ?? undefined}
        data-panel-animations={routePanelAnimationsActive ? "true" : "false"}
        defaultOpen
        // Stays mounted but slid away; "hidden" keeps headers from clearing a toggle.
        {...(sidebarHidden ? { open: false, "data-sidebar-state": "hidden" } : {})}
        style={sidebarProviderStyle}
      >
        <ProjectProjectionRetention />
        {/* Above the panel, so the sidebar slides away under it. */}
        {frame ? <SpaceRail className="relative z-20 bg-(--app-frame)" /> : null}
        {/* No stacking context here: the desktop's browser webviews are drawn at the
            app root, and the panes' floating controls must stack with them. */}
        <div className="relative flex min-h-0 min-w-0 flex-1" data-app-panel="">
          {/* Paint containment anchors the off-canvas sidebar to this clipping
              column, so translucent rails cannot reveal rows sliding behind them. */}
          <div
            data-sidebar-panel=""
            className={cn("relative shrink-0", frame && "overflow-clip [contain:paint]")}
          >
            <Sidebar
              side="left"
              collapsible="offcanvas"
              data-app-sidebar=""
              role="navigation"
              aria-label={isOnSettings ? "Settings" : "Threads"}
              resizable={{
                maxWidth: sidebarMaximumWidth,
                minWidth: sidebarMinimumWidth,
                shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
                  nextWidth <= currentWidth ||
                  wrapper.clientWidth - railWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
                storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
                onResize: setSidebarWidth,
              }}
              // The narrow-window sidebar is a sheet, portaled outside the provider's styles.
              style={windowControlsInsetStyle}
            >
              <MobileSpaceRailLayout enabled={frame === null}>
                {sidebarContent}
              </MobileSpaceRailLayout>
              <SidebarRail onDoubleClick={resetSidebarWidth} />
            </Sidebar>
          </div>
          <PersistentSuitePages>{children}</PersistentSuitePages>
          {frame ? <AppFramePanelEdge /> : null}
        </div>
        {sidebarHidden ? null : <SidebarControl onWidthChange={setTitlebarControlsWidth} />}
        <NavigationHistoryShortcuts />
        <MainAppLocationTracker />
      </SidebarProvider>
    </PanelAnimationSuppressionProvider>
  );
}
