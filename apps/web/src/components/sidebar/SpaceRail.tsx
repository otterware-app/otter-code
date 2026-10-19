import { scopeProjectRef, scopedProjectKey } from "@t3tools/client-runtime/environment";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import {
  useActiveProjectSpace,
  useProjectGroups,
  useSelectProjectSpace,
} from "../../hooks/useProjectSpace";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { CentralIcon } from "../../lib/central-icons";
import {
  ClockIcon,
  CodeReviewIcon,
  FoldersIcon,
  FolderIcon,
  HomeIcon,
  SettingsIcon,
  UsageGaugeIcon,
  type LucideIcon,
} from "../../lib/icons";
import { sortThreads } from "../../lib/threadSort";
import { cn } from "../../lib/utils";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { projectSpaceIcon } from "../../projectSpaces";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { readThreadShells, useProjects } from "../../state/entities";
import {
  useEnvironmentIdentities,
  usePrimaryEnvironmentId,
  usePullRequestsSupported,
} from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { RailCustomizePopover } from "./RailCustomizePopover";
import { RailMoreMenu } from "./RailMoreMenu";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import {
  activeRailShortcutKey,
  normalizeHiddenRailItems,
  normalizeRailItemOrder,
  projectRailSpaceId,
  pruneRemovedRailShortcuts,
  railProjectShortcutKey,
  railSpaceShortcutKey,
  RAIL_ITEM_LABELS,
  reorderRailKeys,
  resolveRailShortcuts,
  toggleRailShortcut,
  visibleRailItems,
  type RailItemId,
} from "./spaceRail.logic";

const RAIL_BUTTON =
  "relative flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-sidebar-muted-foreground/65 outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset [-webkit-app-region:no-drag]";
const RAIL_GLYPHS: Readonly<Record<RailItemId, LucideIcon>> = {
  home: HomeIcon,
  spaces: FoldersIcon,
  pullRequests: CodeReviewIcon,
  automations: ClockIcon,
};

function RailButton({
  label,
  selected = false,
  onClick,
  children,
  buttonRef,
  buttonProps,
  tooltipDisabled = false,
}: {
  label: string;
  selected?: boolean;
  onClick: () => void;
  children: ReactNode;
  buttonRef?: Ref<HTMLButtonElement>;
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  tooltipDisabled?: boolean;
}) {
  return (
    <Tooltip disabled={tooltipDisabled}>
      <TooltipTrigger
        render={
          <button
            ref={buttonRef}
            {...buttonProps}
            type="button"
            aria-label={label}
            aria-current={selected ? "page" : undefined}
            onClick={onClick}
            className={cn(
              RAIL_BUTTON,
              buttonProps?.className,
              selected && "bg-sidebar-row-selected text-sidebar-foreground",
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

type RailShortcutItem = { id: string; label: string; icon: ReactNode; onSelect: () => void };

function SortableRailShortcut({
  item,
  selected,
  dragging,
  onSelect,
}: {
  item: RailShortcutItem;
  selected: boolean;
  dragging: boolean;
  onSelect: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative size-9 shrink-0", isDragging && "z-20")}
    >
      <RailButton
        label={item.label}
        selected={selected}
        onClick={onSelect}
        buttonRef={setActivatorNodeRef}
        buttonProps={{
          ...attributes,
          ...listeners,
          className: "touch-none cursor-grab active:cursor-grabbing",
        }}
        tooltipDisabled={dragging}
      >
        {item.icon}
      </RailButton>
    </div>
  );
}

export const SpaceRail = memo(function SpaceRail({ className }: { className?: string }) {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile, open, setOpen } = useSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  const pullRequestsSupported = usePullRequestsSupported();
  const railShortcuts = useClientSettings((settings) => settings.railShortcuts);
  const railItemOrder = useClientSettings((settings) => settings.railItemOrder);
  const hiddenRailItems = useClientSettings((settings) => settings.hiddenRailItems);
  const threadSortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  useEffect(() => {
    const next = pruneRemovedRailShortcuts(railShortcuts);
    if (next.length !== railShortcuts.length) void updateClientSettings({ railShortcuts: next });
  }, [railShortcuts]);
  const selectSpace = useSelectProjectSpace();
  const { space } = useActiveProjectSpace();
  const { groups: spaces } = useProjectGroups();
  const projects = useProjects();
  const environmentIdentities = useEnvironmentIdentities();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectScopeKey = useUiStateStore((state) => state.sidebarProjectScopeKey);
  const handleNewThread = useNewThreadHandler();
  const [customizing, setCustomizing] = useState(false);
  const [draggingShortcut, setDraggingShortcut] = useState(false);
  const shortcutDragInProgress = useRef(false);
  const suppressNextShortcutClick = useRef(false);
  const shortcutDragEndedAt = useRef(Number.NEGATIVE_INFINITY);
  const shortcutSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const threadsShowing = !isSidebarUtilityPage(pathname);
  const environmentLabels = new Map(
    environmentIdentities.map((entry) => [entry.environmentId, entry.label]),
  );
  const projectGroups = buildSidebarProjectSnapshots({
    projects: projects.filter((project) => !project.isScratch),
    settings: groupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => environmentLabels.get(environmentId) ?? null,
  }).toSorted((left, right) => left.displayName.localeCompare(right.displayName));
  const projectByKey = new Map(projectGroups.map((project) => [project.projectKey, project]));
  const shortcuts = resolveRailShortcuts({
    keys: railShortcuts,
    spaceIds: new Set(spaces.map((entry) => entry.id)),
    projectKeys: new Set(projectGroups.map((project) => project.projectKey)),
  });
  const selectedShortcut = activeRailShortcutKey({
    threadsShowing,
    space,
    projectScopeKey,
    shortcuts,
  });
  const activeItem: RailItemId | null = threadsShowing
    ? "home"
    : pathname === "/spaces"
      ? "spaces"
      : pathname === "/pull-requests"
        ? "pullRequests"
        : pathname === "/settings/scheduled-tasks"
          ? "automations"
          : null;
  const itemOrder = normalizeRailItemOrder(railItemOrder);
  const hidden = new Set(normalizeHiddenRailItems(hiddenRailItems));
  const availableItems = itemOrder.filter((id) => id !== "pullRequests" || pullRequestsSupported);
  const visibleItems = visibleRailItems({
    order: itemOrder,
    hidden: hiddenRailItems,
    activeItem,
    pullRequestsSupported,
  });

  const showSidebar = () => {
    if (!isMobile && !open) setOpen(true);
  };
  const leaveSheet = () => {
    if (isMobile) setOpenMobile(false);
  };
  const selectBuiltIn = (id: RailItemId) => {
    if (id === "home") {
      selectSpace(null);
      showSidebar();
      if (!threadsShowing) void navigateToMainApp();
    } else if (id === "spaces") {
      leaveSheet();
      void navigate({ to: "/spaces" });
    } else if (id === "pullRequests") {
      leaveSheet();
      void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
    } else {
      leaveSheet();
      void navigate({ to: "/settings/scheduled-tasks" });
    }
  };
  const openProject = (project: SidebarProjectSnapshot) => {
    selectSpace(
      projectRailSpaceId({ projectKey: project.projectKey, spaces, activeSpaceId: space.id }),
    );
    const ui = useUiStateStore.getState();
    ui.setSidebarProjectScopeKey(project.projectKey);
    showSidebar();
    const members = new Set(project.memberProjectRefs.map(scopedProjectKey));
    const latestThread = sortThreads(
      readThreadShells().filter(
        (thread) =>
          thread.archivedAt === null &&
          members.has(scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId))),
      ),
      threadSortOrder,
    )[0];
    if (latestThread) {
      leaveSheet();
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId: latestThread.environmentId,
          threadId: latestThread.id,
        }),
      });
    } else {
      leaveSheet();
      void handleNewThread(scopeProjectRef(project.environmentId, project.id));
    }
  };
  const shortcutItems = shortcuts.flatMap((shortcut) => {
    if (shortcut.kind === "space") {
      const entry = spaces.find((candidate) => candidate.id === shortcut.spaceId);
      if (!entry) return [];
      return [
        {
          id: shortcut.key,
          label: entry.name,
          icon: (
            <CentralIcon
              name={projectSpaceIcon(entry)}
              variant={selectedShortcut === shortcut.key ? "fill" : "reversed"}
              className="size-5"
            />
          ),
          onSelect: () => {
            selectSpace(shortcut.spaceId);
            showSidebar();
            if (!threadsShowing) void navigateToMainApp();
          },
        },
      ];
    }
    const project = projectByKey.get(shortcut.projectKey);
    return project
      ? [
          {
            id: shortcut.key,
            label: project.displayName,
            icon: (
              <ProjectFavicon
                project={project}
                fallbackIcon={FolderIcon}
                fallback="icon"
                className="size-5"
              />
            ),
            onSelect: () => openProject(project),
          },
        ]
      : [];
  });
  const toggleShortcut = (key: string) => {
    void updateClientSettings({ railShortcuts: toggleRailShortcut(railShortcuts, key) });
  };

  return (
    <nav
      aria-label="Primary"
      data-app-sidebar=""
      data-space-rail=""
      className={cn(
        "flex w-(--workspace-rail-width) shrink-0 flex-col items-center pb-2.5 text-sidebar-foreground",
        className,
      )}
    >
      <div
        aria-hidden
        className="drag-region hidden h-(--workspace-topbar-height) w-full shrink-0 in-data-[app-frame=window]:block"
      />
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto pt-2.5 [scrollbar-width:none]">
        {visibleItems.map((id) => {
          const Icon = RAIL_GLYPHS[id];
          return (
            <RailButton
              key={id}
              label={RAIL_ITEM_LABELS[id]}
              selected={activeItem === id && selectedShortcut === null}
              onClick={() => selectBuiltIn(id)}
              tooltipDisabled={draggingShortcut}
            >
              <Icon className="size-5" />
            </RailButton>
          );
        })}
        {shortcutItems.length > 0 ? (
          <div aria-hidden className="my-0.5 h-px w-5 shrink-0 bg-sidebar-border" />
        ) : null}
        {shortcutItems.length > 0 ? (
          <DndContext
            sensors={shortcutSensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragStart={() => {
              shortcutDragInProgress.current = true;
              suppressNextShortcutClick.current = true;
              setDraggingShortcut(true);
            }}
            onDragEnd={({ active, over }) => {
              shortcutDragInProgress.current = false;
              shortcutDragEndedAt.current = performance.now();
              setDraggingShortcut(false);
              if (!over) return;
              const next = reorderRailKeys(railShortcuts, String(active.id), String(over.id));
              if (next !== railShortcuts) void updateClientSettings({ railShortcuts: next });
            }}
            onDragCancel={() => {
              shortcutDragInProgress.current = false;
              shortcutDragEndedAt.current = performance.now();
              setDraggingShortcut(false);
            }}
          >
            <SortableContext
              items={shortcutItems.map((item) => item.id)}
              strategy={verticalListSortingStrategy}
            >
              <div
                className="flex shrink-0 flex-col items-center gap-1.5"
                onPointerDownCapture={(event) => {
                  if (
                    !shortcutDragInProgress.current &&
                    event.timeStamp > shortcutDragEndedAt.current
                  )
                    suppressNextShortcutClick.current = false;
                }}
                onKeyDownCapture={(event) => {
                  // The native keyboard sensor may finish before React's capture handler.
                  if (
                    !shortcutDragInProgress.current &&
                    event.timeStamp > shortcutDragEndedAt.current &&
                    (event.key === "Enter" || event.key === " ")
                  )
                    suppressNextShortcutClick.current = false;
                }}
              >
                {shortcutItems.map((item) => (
                  <SortableRailShortcut
                    key={item.id}
                    item={item}
                    selected={selectedShortcut === item.id}
                    dragging={draggingShortcut}
                    onSelect={() => {
                      if (shortcutDragInProgress.current || suppressNextShortcutClick.current) {
                        suppressNextShortcutClick.current = false;
                        return;
                      }
                      item.onSelect();
                    }}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : null}
        <RailMoreMenu
          spaces={spaces.map((entry) => ({
            key: railSpaceShortcutKey(entry.id),
            label: entry.name,
          }))}
          projects={projectGroups.map((project) => ({
            key: railProjectShortcutKey(project.projectKey),
            label: project.displayName,
          }))}
          pinnedKeys={new Set(shortcuts.map((shortcut) => shortcut.key))}
          hiddenItems={availableItems
            .filter((id) => hidden.has(id))
            .map((id) => ({ id, label: RAIL_ITEM_LABELS[id], onSelect: () => selectBuiltIn(id) }))}
          onToggleShortcut={toggleShortcut}
          onCustomize={() => setCustomizing(true)}
          triggerRef={moreButtonRef}
          buttonClassName={RAIL_BUTTON}
          tooltipDisabled={draggingShortcut}
        />
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1.5 pt-1">
        <SidebarUpdatePill />
        <RailButton
          label="Usage"
          selected={pathname === "/usage"}
          tooltipDisabled={draggingShortcut}
          onClick={() => {
            leaveSheet();
            void navigate({ to: "/usage" });
          }}
        >
          <UsageGaugeIcon className="size-5" />
        </RailButton>
        <RailButton
          label="Settings"
          selected={pathname.startsWith("/settings") && pathname !== "/settings/scheduled-tasks"}
          tooltipDisabled={draggingShortcut}
          onClick={() => {
            leaveSheet();
            void navigate({ to: "/settings" });
          }}
        >
          <SettingsIcon className="size-5" />
        </RailButton>
      </div>
      <RailCustomizePopover
        open={customizing}
        onOpenChange={setCustomizing}
        anchor={moreButtonRef}
        items={availableItems.map((id) => {
          const Icon = RAIL_GLYPHS[id];
          return {
            id,
            label: RAIL_ITEM_LABELS[id],
            icon: <Icon className="size-4" />,
            visible: !hidden.has(id),
            locked: id === "home",
          };
        })}
        shortcuts={shortcutItems.map((item) => ({ ...item, visible: true }))}
        onItemReorder={(active, over) => {
          void updateClientSettings({ railItemOrder: reorderRailKeys(itemOrder, active, over) });
        }}
        onItemVisibleChange={(id, visible) => {
          void updateClientSettings({
            hiddenRailItems: normalizeHiddenRailItems(
              visible ? hiddenRailItems.filter((entry) => entry !== id) : [...hiddenRailItems, id],
            ),
          });
        }}
        onShortcutReorder={(active, over) => {
          void updateClientSettings({
            railShortcuts: reorderRailKeys(railShortcuts, active, over),
          });
        }}
        onShortcutRemove={toggleShortcut}
      />
    </nav>
  );
});
