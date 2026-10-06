import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";

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
import { resolveThreadRouteRef } from "../threadRoutes";
import { cn, isMacPlatform } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useEnvironmentIdentificationMode, useLegacySidebarEnabled } from "../hooks/useSettings";
import {
  PanelAnimationSuppressionProvider,
  usePanelAnimationSettings,
  usePanelNavigationSuppression,
} from "../panelAnimations";
import LegacyThreadSidebar from "./LegacySidebar";
import { useThreadVisitedMigration } from "../hooks/useThreadVisitedMigration";
import ThreadSidebar from "./Sidebar";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { SidebarChromeHeader, SidebarSpaceTitle } from "./sidebar/SidebarChrome";
import { MainAppLocationTracker } from "./sidebar/mainAppLocation";
import { SpaceRail } from "./sidebar/SpaceRail";
import { useAppFrame } from "./sidebar/appFrame";
import { useSidebarStageBackdropVariant } from "./SidebarStageBackdrop";
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

const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "var(--desktop-window-controls-inset, 82px)";
/** The rail's width (appFrame.css's --workspace-rail-width). */
const SPACE_RAIL_WIDTH = 52;
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

function SidebarControl() {
  const usagePageOpen = useLocation({ select: (location) => location.pathname === "/usage" });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar } = useSidebar();
  const isSidebarVisible = useSidebarVisibility();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const stageBackdropVariant = useSidebarStageBackdropVariant(
    environmentIdentificationMode === "artwork",
  );
  // In the desktop app's frame the toggle sits on the title band, above the art.
  const frame = useAppFrame();
  const overArtwork = isSidebarVisible && stageBackdropVariant !== null && frame !== "window";
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle", {
    context: { usagePageOpen },
  });

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

    // Capture before focused editors consume commands such as Mod+B for rich-text formatting.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, toggleSidebar, usagePageOpen]);

  return (
    // The right-side layout controls carry mr-px (border compensation inside
    // the panel), so the trigger mirrors it: both clusters sit one extra pixel
    // off their edge and the titlebar reads symmetric.
    <div
      className="pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 ml-px flex h-[var(--workspace-topbar-height)] items-center"
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
    </div>
  );
}

// Moves through the app's route history like a browser's back/forward buttons.
function NavigationHistoryShortcuts() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });

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
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  // Settings routes show the settings nav in place of whichever thread
  // sidebar is active.
  // Seeds server-side visited tracking from this browser's localStorage the
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
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth);
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
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(() => {
    const getWindowFullscreenState = window.desktopBridge?.getWindowFullscreenState;
    return isMacosDesktop && typeof getWindowFullscreenState === "function"
      ? getWindowFullscreenState()
      : false;
  });
  const sidebarProviderStyle = {
    "--sidebar-width": `${clampThreadSidebarWidth(sidebarWidth, sidebarMinimumWidth, sidebarMaximumWidth)}px`,
    "--panel-animation-duration": `${panelAnimationDurationMs}ms`,
    ...(frame ? { "--workspace-controls-left": FRAMED_CONTROLS_LEFT } : {}),
    ...(isMacosDesktop && !isWindowFullscreen
      ? { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : {}),
    // Headers place their content after the pinned toggle, in their own
    // coordinates: the panes start after the rail.
    ...(frame
      ? {
          "--workspace-titlebar-content-left":
            "calc(var(--workspace-controls-left) + var(--workspace-titlebar-control-size) + var(--workspace-titlebar-control-gap) - var(--workspace-rail-width))",
        }
      : {}),
  } as CSSProperties;

  useEffect(() => {
    if (!isMacosDesktop) return;
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const { getWindowFullscreenState, onWindowFullscreenStateChange } = bridge;
    if (
      typeof getWindowFullscreenState !== "function" ||
      typeof onWindowFullscreenStateChange !== "function"
    ) {
      return;
    }

    const unsubscribe = onWindowFullscreenStateChange(setIsWindowFullscreen);
    setIsWindowFullscreen(getWindowFullscreenState());
    return unsubscribe;
  }, [isMacosDesktop]);

  // The layout re-renders on every window resize (the sidebar's width limits
  // follow it); the sidebar's content does not depend on it, so it keeps one
  // element and React skips it.
  const sidebarContent = useMemo(
    () =>
      isOnSettings ? (
        <>
          <SidebarChromeHeader isElectron={isElectron}>
            <SidebarSpaceTitle>Settings</SidebarSpaceTitle>
          </SidebarChromeHeader>
          <SettingsSidebarNav pathname={pathname} />
        </>
      ) : legacySidebarEnabled ? (
        <LegacyThreadSidebar />
      ) : (
        <ThreadSidebar />
      ),
    [isOnSettings, legacySidebarEnabled, pathname],
  );

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
        style={sidebarProviderStyle}
      >
        <ProjectProjectionRetention />
        {/* Above the panel, so the sidebar slides away under it. */}
        {frame ? <SpaceRail className="relative z-20 bg-(--app-frame)" /> : null}
        <div
          className={cn("relative flex min-h-0 min-w-0 flex-1", frame && "isolate")}
          data-app-panel=""
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
          >
            <MobileSpaceRailLayout enabled={frame === null}>{sidebarContent}</MobileSpaceRailLayout>
            <SidebarRail onDoubleClick={resetSidebarWidth} />
          </Sidebar>
          {children}
          {frame ? <AppFramePanelEdge /> : null}
        </div>
        <SidebarControl />
        <NavigationHistoryShortcuts />
        <MainAppLocationTracker />
      </SidebarProvider>
    </PanelAnimationSuppressionProvider>
  );
}
