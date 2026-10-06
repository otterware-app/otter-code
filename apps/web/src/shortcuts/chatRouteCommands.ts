import {
  AuthPreviewOperateScope,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { isPreviewAvailableFor } from "../browser/previewRuntime";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { useComposerDraftStore } from "../composerDraftStore";
import { dispatchPreviewAction, type PreviewAction } from "../components/preview/previewActionBus";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { createNewThreadHandler, resolveDefaultProjectRef } from "../hooks/useHandleNewThread";
import { readActiveProjectSpace } from "../hooks/useProjectSpace";
import { createScratchProjectActions } from "../hooks/useScratchProject";
import { getClientSettings } from "../hooks/useSettings";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { readProjects, readThreadShell } from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { readEnvironmentScope } from "../state/session";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { type CommandHandler, registerCommands } from "./dispatcher";

const CHAT_ROUTE_ID = "/_chat";

/**
 * New-thread and preview commands, live while a chat route is showing and no
 * modal page (Settings, Usage) covers it. Everything is read at event time, so
 * the scope is registered once instead of re-registering on every store change.
 */
export function installChatRouteCommands(router: AnyRouter): () => void {
  const handleNewThread = createNewThreadHandler(router);
  const scratch = createScratchProjectActions({
    environments: () =>
      [...appAtomRegistry.get(environmentPresentations.presentationsAtom)].map(
        ([environmentId, presentation]) => ({ ...presentation, environmentId }),
      ),
    registry: appAtomRegistry,
    handleNewThread,
  });

  const readRouteTarget = () => resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const readRouteThreadRef = () => {
    const target = readRouteTarget();
    return target?.kind === "server" ? target.threadRef : null;
  };
  const readPreviewOpen = () => {
    const threadRef = readRouteThreadRef();
    // Store-only on purpose: the URL-aware arbitration lives in ChatView's
    // preview toggle, which the action bus reaches.
    return threadRef
      ? selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef) === "preview"
      : false;
  };
  // New threads default to a project in the rail's space, and do not follow
  // the open thread out of it. A space with no projects (an empty group, or
  // Chats on a machine without a no-project home) leaves every project open.
  const readSpaceProjects = () => {
    const allProjects = readProjects();
    const { projectFilter } = readActiveProjectSpace();
    const spaceProjects = projectFilter === null ? allProjects : allProjects.filter(projectFilter);
    return {
      projects: spaceProjects.length > 0 ? spaceProjects : allProjects,
      scoped: projectFilter !== null && spaceProjects.length > 0,
    };
  };
  const readThreadContext = () => {
    const target = readRouteTarget();
    const { projects, scoped } = readSpaceProjects();
    const spaceKeys = new Set(projects.map((project) => `${project.environmentId}:${project.id}`));
    const drafts = useComposerDraftStore.getState();
    const activeThread = target?.kind === "server" ? readThreadShell(target.threadRef) : null;
    const activeDraftThread = target
      ? target.kind === "server"
        ? drafts.getDraftThread(target.threadRef)
        : drafts.getDraftSession(target.draftId)
      : null;
    return {
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef: resolveDefaultProjectRef(
        projects,
        useUiStateStore.getState().projectOrder,
      ),
      handleNewThread,
      isProjectInSpace: scoped
        ? (projectRef: ScopedProjectRef) =>
            spaceKeys.has(`${projectRef.environmentId}:${projectRef.projectId}`)
        : undefined,
    };
  };
  // Counted within the rail's space: a group of one project has no choice to make.
  const readProjectGroupCount = () =>
    buildSidebarProjectSnapshots({
      projects: readSpaceProjects().projects,
      settings: selectProjectGroupingSettings(getClientSettings()),
      primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
      resolveEnvironmentLabel: () => null,
    }).length;
  const canOperatePreview = (environmentId: EnvironmentId) =>
    readEnvironmentScope(environmentId, AuthPreviewOperateScope);

  const readScratchEnvironmentId = () => {
    const { activeThread, activeDraftThread } = readThreadContext();
    return scratch.scratchEnvironmentId(
      activeThread?.environmentId ??
        activeDraftThread?.environmentId ??
        appAtomRegistry.get(primaryEnvironmentIdAtom),
    );
  };

  const claim = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const startNewLocal: CommandHandler = (event) => {
    claim(event);
    void startNewThreadFromContext(readThreadContext());
  };

  const previewCommand =
    (action: PreviewAction): CommandHandler =>
    (event) => {
      claim(event);
      const threadRef = readRouteThreadRef();
      if (threadRef && canOperatePreview(threadRef.environmentId)) dispatchPreviewAction(action);
    };

  return registerCommands(
    {
      "chat.newLocal": startNewLocal,
      "chat.newWithoutProject": (event) => {
        const environmentId = readScratchEnvironmentId();
        if (environmentId === null) return;
        claim(event);
        void scratch.startScratchThread(environmentId);
      },
      "chat.new": (event) => {
        // In Chats, chat.new starts without a project too, unless the machine
        // offers no such home; then it falls through to the ordinary new thread.
        if (readActiveProjectSpace().space.kind === "chats") {
          const environmentId = readScratchEnvironmentId();
          if (environmentId !== null) {
            claim(event);
            void scratch.startScratchThread(environmentId);
            return;
          }
        }
        // Pre-hydration settings are the defaults, where the legacy sidebar is off.
        if (!getClientSettings().legacySidebarEnabled && readProjectGroupCount() > 1) {
          claim(event);
          openCommandPalette({ open: "new-thread-in" });
          return;
        }
        startNewLocal(event);
      },
      "preview.toggle": (event) => {
        claim(event);
        const threadRef = readRouteThreadRef();
        if (!threadRef || (!canOperatePreview(threadRef.environmentId) && !readPreviewOpen())) {
          return;
        }
        if (!isPreviewAvailableFor(threadRef.environmentId)) {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Preview is desktop-only",
              description: "Open Otter Code in the desktop app to use the in-app preview.",
            }),
          );
          return;
        }
        dispatchPreviewAction("toggle-panel");
      },
      "preview.refresh": previewCommand("refresh"),
      "preview.focusUrl": previewCommand("focus-url"),
      "preview.zoomIn": previewCommand("zoom-in"),
      "preview.zoomOut": previewCommand("zoom-out"),
      "preview.resetZoom": previewCommand("reset-zoom"),
    },
    {
      when: () =>
        router.state.matches.some((match) => match.routeId === CHAT_ROUTE_ID) &&
        !router.state.matches.some((match) => isAppModalPage(match.pathname)) &&
        !isCommandPaletteOpen(),
      context: () => {
        const threadRef = readRouteThreadRef();
        return {
          terminalOpen: threadRef
            ? selectThreadTerminalUiState(
                useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
                threadRef,
              ).terminalOpen
            : false,
          previewOpen: readPreviewOpen(),
        };
      },
      onKeyDown: (event) => {
        if (event.key !== "Escape") return false;
        const selection = useThreadSelectionStore.getState();
        if (selection.selectedThreadKeys.size === 0) return false;
        event.preventDefault();
        selection.clearSelection();
      },
    },
  );
}
