import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { ProjectGroupSetting } from "@t3tools/contracts";
import { FolderPlusIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useMemo } from "react";

import { useProjectGroups } from "../../hooks/useProjectSpace";
import { useClientSettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { deriveProjectIdentity } from "../../projectIdentity";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProjectMonogram } from "../ProjectMonogram";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** The first "New group", "New group 2", ... that no group is called yet. */
function nextGroupName(groups: ReadonlyArray<ProjectGroupSetting>): string {
  const names = new Set(groups.map((group) => group.name));
  for (let index = 1; ; index += 1) {
    const name = index === 1 ? "New group" : `New group ${index}`;
    if (!names.has(name)) return name;
  }
}

/**
 * The rail's project groups. Each one is a space of its own: its threads in
 * the sidebar, and only its projects offered to new threads. Saved on every
 * connected environment so each device shows the same groups.
 */
export function ProjectGroupsSettings() {
  const { groups } = useProjectGroups();
  const updateSettings = useUpdatePrimarySettings();
  const projects = useProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  // Every project a group can hold, as the sidebar names them. The machines'
  // no-project homes belong to Chats, not to a group.
  const projectOptions = useMemo(() => {
    const scratchRootByEnvironment = new Map(
      environments.map(
        (environment) =>
          [environment.environmentId, environment.serverConfig?.scratchWorkspaceRoot] as const,
      ),
    );
    return buildSidebarProjectSnapshots({
      projects: projects.filter(
        (project) =>
          !isScratchProject(project, scratchRootByEnvironment.get(project.environmentId)),
      ),
      settings: groupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    }).toSorted((left, right) => left.displayName.localeCompare(right.displayName));
  }, [environments, groupingSettings, primaryEnvironmentId, projects]);
  const projectOptionByKey = useMemo(
    () => new Map(projectOptions.map((option) => [option.projectKey, option] as const)),
    [projectOptions],
  );

  const saveGroups = (next: ReadonlyArray<ProjectGroupSetting>) =>
    updateSettings({ railProjectGroups: next });
  const updateGroup = (id: string, change: (group: ProjectGroupSetting) => ProjectGroupSetting) =>
    saveGroups(groups.map((group) => (group.id === id ? change(group) : group)));

  return (
    <SettingsPageContainer>
      <SettingsSection
        id={searchableSetting("project-groups").id}
        title="Project groups"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              saveGroups([
                ...groups,
                { id: randomUUID(), name: nextGroupName(groups), projectKeys: [] },
              ])
            }
          >
            <PlusIcon />
            New group
          </Button>
        }
      >
        <SettingsRow
          title="Groups in the rail"
          description={
            groups.length === 0
              ? "Make a group to give a set of projects its own space in the rail. All projects and Chats are always there."
              : "Each group lists its threads in the sidebar and offers only its projects to new threads. All projects and Chats are always there."
          }
        />
      </SettingsSection>
      {groups.map((group) => {
        const identity = deriveProjectIdentity(group.name);
        const memberKeys = new Set(group.projectKeys);
        const addable = projectOptions.filter((option) => !memberKeys.has(option.projectKey));
        return (
          <SettingsSection
            key={group.id}
            title={group.name}
            icon={<ProjectMonogram text={identity.monogram} color={identity.color} />}
            headerAction={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Delete ${group.name}`}
                onClick={() => saveGroups(groups.filter((entry) => entry.id !== group.id))}
              >
                <Trash2Icon />
              </Button>
            }
          >
            <SettingsRow
              title="Name"
              control={
                <Input
                  // Remounts when the saved name changes elsewhere.
                  key={group.name}
                  size="sm"
                  aria-label={`${group.name} name`}
                  defaultValue={group.name}
                  className="w-48"
                  onBlur={(event) => {
                    const name = event.currentTarget.value.trim();
                    if (name.length === 0) {
                      event.currentTarget.value = group.name;
                      return;
                    }
                    if (name !== group.name) updateGroup(group.id, (entry) => ({ ...entry, name }));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      event.currentTarget.value = group.name;
                      event.currentTarget.blur();
                    }
                  }}
                />
              }
            />
            <SettingsRow
              title="Projects"
              description={
                group.projectKeys.length === 0
                  ? "No projects yet."
                  : `${group.projectKeys.length} ${group.projectKeys.length === 1 ? "project" : "projects"}`
              }
              control={
                <Menu>
                  <MenuTrigger
                    render={<Button size="sm" variant="outline" disabled={addable.length === 0} />}
                  >
                    <FolderPlusIcon />
                    Add project
                  </MenuTrigger>
                  <MenuPopup align="end" className="max-h-80 overflow-y-auto">
                    {addable.map((option) => (
                      <MenuItem
                        key={option.projectKey}
                        onClick={() =>
                          updateGroup(group.id, (entry) => ({
                            ...entry,
                            projectKeys: [...entry.projectKeys, option.projectKey],
                          }))
                        }
                      >
                        <ProjectFavicon project={option} className="size-4 shrink-0" />
                        <span className="min-w-0 truncate">{option.displayName}</span>
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              }
            />
            {group.projectKeys.map((projectKey) => {
              const option = projectOptionByKey.get(projectKey);
              return (
                <SettingsRow
                  key={projectKey}
                  title={
                    <span className="flex min-w-0 items-center gap-2">
                      {option ? (
                        <ProjectFavicon project={option} className="size-4 shrink-0" />
                      ) : null}
                      <span className="min-w-0 truncate">
                        {option?.displayName ?? "Unavailable project"}
                      </span>
                    </span>
                  }
                  // A member whose machine is offline or whose project was
                  // removed keeps its place until the user removes it.
                  description={option ? undefined : projectKey}
                  control={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Remove ${option?.displayName ?? "project"} from ${group.name}`}
                      onClick={() =>
                        updateGroup(group.id, (entry) => ({
                          ...entry,
                          projectKeys: entry.projectKeys.filter((key) => key !== projectKey),
                        }))
                      }
                    >
                      <XIcon />
                    </Button>
                  }
                />
              );
            })}
          </SettingsSection>
        );
      })}
    </SettingsPageContainer>
  );
}
