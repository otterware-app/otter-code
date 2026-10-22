import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectGroupSetting,
} from "@t3tools/contracts";
import { useEffect } from "react";

import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import {
  LEGACY_VOID_SPACE_ID,
  moveProjectToSpace,
  projectSpaceFilter,
  resolveProjectSpace,
  type ProjectSpaceProject,
} from "../projectSpaces";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentScope } from "../state/session";
import { useUiStateStore } from "../uiStateStore";
import { useClientSettings, useUpdateEnvironmentSettings } from "./useSettings";

const NO_GROUPS: ReadonlyArray<ProjectGroupSetting> = [];

/** Shared Spaces come from the primary environment, or the first available hosted connection. */
export function useProjectGroups(): {
  readonly groups: ReadonlyArray<ProjectGroupSetting>;
  readonly sourceEnvironmentId: EnvironmentId | null;
} {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
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

export function useActiveProjectSpace() {
  const storedSpaceId = useUiStateStore((store) => store.sidebarProjectSpaceId);
  // oxlint-disable-next-line t3code/react-effect-budget -- Migrates a stored legacy space ID once.
  useEffect(() => {
    if (
      storedSpaceId === LEGACY_VOID_SPACE_ID &&
      useUiStateStore.getState().sidebarProjectSpaceId === LEGACY_VOID_SPACE_ID
    )
      useUiStateStore.getState().setSidebarProjectSpaceId(null);
  }, [storedSpaceId]);
  const { groups } = useProjectGroups();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const { environments } = useEnvironments();
  // Configured roots keep disconnected environments' no-project chats in their scope.
  const scratchWorkspaceRootFor = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.scratchWorkspaceRoot ?? null;
  const space = resolveProjectSpace(storedSpaceId, groups);
  return {
    space,
    projectFilter: projectSpaceFilter({ space, groups, groupingSettings, scratchWorkspaceRootFor }),
  };
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
