import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { ProjectGroupSetting } from "@t3tools/contracts";
import { useState } from "react";

import { useProjectSpaceActions, useSelectProjectSpace } from "../../hooks/useProjectSpace";
import { useClientSettings } from "../../hooks/useSettings";
import {
  AddPlusIcon,
  ArrowRightIcon,
  EllipsisIcon,
  FolderIcon,
  PencilIcon,
  TrashCanIcon,
  XIcon,
} from "../../lib/icons";
import { randomUUID } from "../../lib/utils";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { projectSpaceIcon } from "../../projectSpaces";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { ProjectFavicon } from "../ProjectFavicon";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { SpaceEditorDialog } from "../spaces/SpaceEditorDialog";
import { SpaceIcon } from "../spaces/SpaceIcon";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function ProjectGroupsSettings() {
  const { groups, canEdit, saveSpaces, moveProject } = useProjectSpaceActions();
  const projects = useProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const setSpaceId = useSelectProjectSpace();
  const navigateToMainApp = useNavigateToMainApp();
  const [editor, setEditor] = useState<ProjectGroupSetting | "create" | null>(null);
  const projectOptions = (() => {
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
      resolveEnvironmentLabel: (environmentId) =>
        environments.find((entry) => entry.environmentId === environmentId)?.label ?? null,
    }).toSorted((left, right) => left.displayName.localeCompare(right.displayName));
  })();
  const projectByKey = new Map(projectOptions.map((project) => [project.projectKey, project]));
  const assignedKeys = new Set(groups.flatMap((group) => group.projectKeys));
  const unassigned = projectOptions.filter((project) => !assignedKeys.has(project.projectKey));

  const projectTitle = (project: SidebarProjectSnapshot | undefined) => (
    <span className="flex min-w-0 items-center gap-2">
      {project ? <ProjectFavicon project={project} className="size-4 shrink-0" /> : null}
      <span className="min-w-0 truncate">{project?.displayName ?? "Unavailable project"}</span>
    </span>
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        id={searchableSetting("project-groups").id}
        title="Spaces"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={!canEdit}
            onClick={() => setEditor("create")}
          >
            <AddPlusIcon />
            New space
          </Button>
        }
      >
        <SettingsRow
          title="A place for each kind of work"
          description="Organize projects into Spaces. Home shows every project; selecting a Space selects its projects."
        />
      </SettingsSection>

      {groups.map((group) => {
        const members = new Set(group.projectKeys);
        const addable = projectOptions.filter((project) => !members.has(project.projectKey));
        return (
          <SettingsSection
            key={group.id}
            title={group.name}
            icon={<SpaceIcon icon={projectSpaceIcon(group)} />}
            headerAction={
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`${group.name} actions`}
                    />
                  }
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem
                    onClick={() => {
                      setSpaceId(group.id);
                      void navigateToMainApp();
                    }}
                  >
                    <SpaceIcon icon={projectSpaceIcon(group)} />
                    Open space
                  </MenuItem>
                  <MenuItem disabled={!canEdit} onClick={() => setEditor(group)}>
                    <PencilIcon />
                    Edit space…
                  </MenuItem>
                  <MenuItem
                    disabled={!canEdit}
                    onClick={() => saveSpaces(groups.filter((entry) => entry.id !== group.id))}
                  >
                    <TrashCanIcon />
                    Delete space
                  </MenuItem>
                </MenuPopup>
              </Menu>
            }
          >
            <SettingsRow
              title={`${group.projectKeys.length} ${group.projectKeys.length === 1 ? "project" : "projects"}`}
              description={
                group.projectKeys.length === 0
                  ? "Add a project to start working in this Space."
                  : undefined
              }
              control={
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!canEdit || addable.length === 0}
                      />
                    }
                  >
                    <AddPlusIcon />
                    Add project
                  </MenuTrigger>
                  <MenuPopup align="end">
                    {addable.map((project) => (
                      <MenuItem
                        key={project.projectKey}
                        onClick={() => moveProject(project.projectKey, group.id)}
                      >
                        {projectTitle(project)}
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              }
            />
            {group.projectKeys.map((key) => {
              const project = projectByKey.get(key);
              return (
                <SettingsRow
                  key={key}
                  title={projectTitle(project)}
                  description={
                    project
                      ? undefined
                      : "This project is unavailable. Its Space membership is preserved."
                  }
                  control={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      disabled={!canEdit}
                      aria-label={`Remove ${project?.displayName ?? "project"} from ${group.name}`}
                      onClick={() => moveProject(key, null)}
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

      <SettingsSection title="Unassigned" icon={<FolderIcon className="size-4" />}>
        <SettingsRow
          title="Unassigned projects"
          description={
            unassigned.length === 0
              ? "Every project has a Space."
              : "These projects appear in Home. Add them to a Space to select them together."
          }
        />
        {unassigned.map((project) => (
          <SettingsRow
            key={project.projectKey}
            title={projectTitle(project)}
            control={
              <Menu>
                <MenuTrigger
                  render={
                    <Button size="sm" variant="ghost" disabled={!canEdit || groups.length === 0} />
                  }
                >
                  <ArrowRightIcon />
                  Move to Space
                </MenuTrigger>
                <MenuPopup align="end">
                  {groups.map((group) => (
                    <MenuItem
                      key={group.id}
                      onClick={() => moveProject(project.projectKey, group.id)}
                    >
                      <SpaceIcon icon={projectSpaceIcon(group)} />
                      {group.name}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            }
          />
        ))}
      </SettingsSection>
      {editor ? (
        <SpaceEditorDialog
          {...(editor === "create"
            ? {}
            : { initialValue: { name: editor.name, icon: projectSpaceIcon(editor) } })}
          existingNames={groups
            .filter((group) => editor === "create" || group.id !== editor.id)
            .map((group) => group.name)}
          onClose={() => setEditor(null)}
          onSave={(value) => {
            if (editor === "create")
              saveSpaces([...groups, { id: randomUUID(), ...value, projectKeys: [] }]);
            else
              saveSpaces(
                groups.map((group) => (group.id === editor.id ? { ...group, ...value } : group)),
              );
          }}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
