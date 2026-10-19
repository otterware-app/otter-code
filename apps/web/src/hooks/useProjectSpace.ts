import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectGroupSetting,
  type ServerConfig,
} from "@t3tools/contracts";
import { useEffect } from "react";

import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  LEGACY_VOID_SPACE_ID,
  moveProjectToSpace,
  projectSpaceFilter,
  resolveProjectSpace,
  type ProjectSpaceProject,
} from "../projectSpaces";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readPrimaryEnvironmentId,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { environmentPresentations } from "../state/presentation";
import { useEnvironmentScope } from "../state/session";
import { useUiStateStore } from "../uiStateStore";
import { getClientSettings, useClientSettings, useUpdateEnvironmentSettings } from "./useSettings";

const NO_GROUPS: ReadonlyArray<ProjectGroupSetting> = [];

interface ProjectSpaceEnvironment {
  readonly environmentId: EnvironmentId;
  readonly serverConfig?: Pick<ServerConfig, "settings" | "scratchWorkspaceRoot"> | null;
}

/** Shared Spaces come from the primary environment, or the first available hosted connection. */
function projectGroupsFrom(
  environments: ReadonlyArray<ProjectSpaceEnvironment>,
  primaryEnvironmentId: EnvironmentId | null,
) {
  const source =
    environments.find(
      (environment) =>
        environment.environmentId === primaryEnvironmentId && environment.serverConfig,
    ) ?? environments.find((environment) => environment.serverConfig);
  return {
    groups: source?.serverConfig?.settings.railProjectGroups ?? NO_GROUPS,
    sourceEnvironmentId: source?.environmentId ?? null,
  };
}

export function useProjectGroups(): {
  readonly groups: ReadonlyArray<ProjectGroupSetting>;
  readonly sourceEnvironmentId: EnvironmentId | null;
} {
  const { environments } = useEnvironments();
  return projectGroupsFrom(environments, usePrimaryEnvironmentId());
}

export function useProjectSpaceActions() {
  const { groups, sourceEnvironmentId } = useProjectGroups();
  const updateSettings = useUpdateEnvironmentSettings(sourceEnvironmentId);
  const canEdit = useEnvironmentScope(sourceEnvironmentId, AuthSettingsWriteScope);
  const saveSpaces = (next: ReadonlyArray<ProjectGroupSetting>) =>
    updateSettings({ railProjectGroups: next });
  const moveProject = (projectKey: string, destinationId: string | null) =>
    saveSpaces(moveProjectToSpace(groups, projectKey, destinationId));
  return { groups, canEdit, saveSpaces, moveProject };
}

function activeProjectSpace(input: {
  readonly storedSpaceId: string | null;
  readonly environments: ReadonlyArray<ProjectSpaceEnvironment>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly groupingSettings: ReturnType<typeof selectProjectGroupingSettings>;
}) {
  const { groups } = projectGroupsFrom(input.environments, input.primaryEnvironmentId);
  // Configured roots keep disconnected environments' no-project chats in their scope.
  const scratchWorkspaceRootFor = (environmentId: EnvironmentId) =>
    input.environments.find((environment) => environment.environmentId === environmentId)
      ?.serverConfig?.scratchWorkspaceRoot ?? null;
  const space = resolveProjectSpace(input.storedSpaceId, groups);
  return {
    space,
    projectFilter: projectSpaceFilter({
      space,
      groups,
      groupingSettings: input.groupingSettings,
      scratchWorkspaceRootFor,
    }),
  };
}

export function useActiveProjectSpace() {
  const storedSpaceId = useUiStateStore((store) => store.sidebarProjectSpaceId);
  useEffect(() => {
    if (
      storedSpaceId === LEGACY_VOID_SPACE_ID &&
      useUiStateStore.getState().sidebarProjectSpaceId === LEGACY_VOID_SPACE_ID
    )
      useUiStateStore.getState().setSidebarProjectSpaceId(null);
  }, [storedSpaceId]);
  const { environments } = useEnvironments();
  return activeProjectSpace({
    storedSpaceId,
    environments,
    primaryEnvironmentId: usePrimaryEnvironmentId(),
    groupingSettings: useClientSettings(selectProjectGroupingSettings),
  });
}

/** The rail's space read at call time, for handlers outside React. */
export function readActiveProjectSpace() {
  return activeProjectSpace({
    storedSpaceId: useUiStateStore.getState().sidebarProjectSpaceId,
    environments: [...appAtomRegistry.get(environmentPresentations.presentationsAtom)].map(
      ([environmentId, presentation]) => ({ ...presentation, environmentId }),
    ),
    primaryEnvironmentId: readPrimaryEnvironmentId(),
    groupingSettings: selectProjectGroupingSettings(getClientSettings()),
  });
}

export function useSelectProjectSpace() {
  return useUiStateStore((state) => state.setSidebarProjectSpaceId);
}

export function useAssignProjectToActiveSpace() {
  const { space } = useActiveProjectSpace();
  const { moveProject } = useProjectSpaceActions();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  return (project: ProjectSpaceProject) => {
    if (space.kind === "group")
      moveProject(deriveLogicalProjectKeyFromSettings(project, groupingSettings), space.id);
  };
}
