import { useReducer, useRef, type KeyboardEvent, type MouseEvent, type RefObject } from "react";

import { FolderIcon, SettingsIcon } from "../../lib/icons";
import {
  projectGroupsSpanEnvironments,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironmentMachines, usePrimaryEnvironmentId } from "../../state/environments";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  filterSidebarProjectScopeItems,
  reduceSidebarProjectScopeMenuState,
} from "../Sidebar.logic";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { SidebarSpaceHeading, SidebarSpaceTitle } from "./SidebarChrome";

export function SidebarProjectHeading({
  groups,
  scopeKey,
  spaceName,
  headingRef,
  onScopeChange,
  onProjectSettings,
}: {
  groups: ReadonlyArray<SidebarProjectSnapshot>;
  scopeKey: string | null;
  spaceName: string;
  headingRef: RefObject<HTMLDivElement | null>;
  onScopeChange: (key: string | null) => void;
  onProjectSettings: (project: SidebarProjectSnapshot) => void;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const machineByEnvironmentId = useEnvironmentMachines();
  const [menuState, dispatch] = useReducer(reduceSidebarProjectScopeMenuState, {
    open: false,
    query: "",
  });
  const filter = useComboboxFilter();
  const highlightedKey = useRef<string | null>(null);
  const suppressNextScopeChange = useRef(false);
  const showEnvironments = projectGroupsSpanEnvironments(groups);
  const items = [
    { value: "all", label: spaceName },
    ...groups.map((group) => ({ value: group.projectKey, label: group.displayName })),
  ];
  const projectByKey = new Map(groups.map((group) => [group.projectKey, group]));
  const selectedProject = scopeKey === null ? null : (projectByKey.get(scopeKey) ?? null);
  const selectedItem = items.find((item) => item.value === (scopeKey ?? "all")) ?? items[0]!;
  const filteredItems = filterSidebarProjectScopeItems({
    items,
    query: menuState.query,
    matches: (item, query) => filter.contains(item, query, (candidate) => candidate.label),
  });

  const openSettings = (
    event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLInputElement>,
    project: SidebarProjectSnapshot,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    // Safari can send a selection click after Ctrl+click opens settings.
    suppressNextScopeChange.current = true;
    dispatch({ type: "project-settings-opened" });
    onProjectSettings(project);
  };
  const title = selectedProject?.displayName ?? spaceName;
  if (groups.length === 0) return <SidebarSpaceTitle>{title}</SidebarSpaceTitle>;

  return (
    <Combobox
      items={items}
      filteredItems={filteredItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(left, right) => left.value === right.value}
      open={menuState.open}
      onOpenChange={(open) => {
        if (open) suppressNextScopeChange.current = false;
        dispatch({ type: "open-changed", open });
      }}
      onItemHighlighted={(item) => {
        highlightedKey.current = item?.value ?? null;
      }}
      value={selectedItem}
      onValueChange={(item) => {
        if (suppressNextScopeChange.current) {
          suppressNextScopeChange.current = false;
          return;
        }
        if (item) onScopeChange(item.value === "all" ? null : item.value);
      }}
    >
      <ComboboxTrigger
        render={
          <SidebarSpaceHeading
            title={title}
            aria-label={
              selectedProject
                ? `Filter threads by project: ${selectedProject.displayName}`
                : "Filter threads by project"
            }
          />
        }
      />
      <ComboboxPopup
        align="start"
        anchor={headingRef}
        className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
      >
        <ComboboxSearchInput
          aria-label="Search projects"
          placeholder="Search projects..."
          value={menuState.query}
          onKeyDown={(event) => {
            if (
              event.defaultPrevented ||
              event.nativeEvent.isComposing ||
              event.ctrlKey ||
              event.altKey ||
              event.metaKey ||
              (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
            )
              return;
            const project = highlightedKey.current
              ? projectByKey.get(highlightedKey.current)
              : null;
            if (project) openSettings(event, project);
          }}
          onChange={(event) => dispatch({ type: "query-changed", query: event.target.value })}
        />
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList>
          {(item: (typeof items)[number]) => {
            const project = projectByKey.get(item.value) ?? null;
            return (
              <ComboboxItem
                key={item.value}
                hideIndicator
                value={item}
                onContextMenu={(event) => {
                  if (project) openSettings(event, project);
                }}
              >
                {project ? (
                  <ProjectFavicon project={project} className="size-4 shrink-0" />
                ) : (
                  <FolderIcon className="size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                {project && showEnvironments ? (
                  <ProjectEnvironmentBadge
                    group={project}
                    primaryEnvironmentId={primaryEnvironmentId}
                    machineByEnvironmentId={machineByEnvironmentId}
                  />
                ) : null}
                {project ? (
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    tabIndex={-1}
                    aria-hidden="true"
                    title={`Project settings for ${project.displayName}`}
                    className="ml-auto"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => openSettings(event, project)}
                  >
                    <SettingsIcon className="size-3.5" />
                  </Button>
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
