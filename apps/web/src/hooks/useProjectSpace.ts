import type { EnvironmentId, ProjectGroupSetting, ServerConfig } from "@t3tools/contracts";
import { selectProjectGroupingSettings } from "../logicalProject";
import { projectSpaceFilter, resolveProjectSpace } from "../projectSpaces";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readPrimaryEnvironmentId,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { environmentPresentations } from "../state/presentation";
import { useUiStateStore } from "../uiStateStore";
import { getClientSettings, useClientSettings, useLegacySidebarEnabled } from "./useSettings";
const NO_GROUPS: ReadonlyArray<ProjectGroupSetting> = [];

interface ProjectSpaceEnvironment {
  readonly environmentId: EnvironmentId;
  readonly serverConfig?: Pick<ServerConfig, "settings" | "scratchWorkspaceRoot"> | null;
}

/**
 * The project groups, as the primary environment holds them. Clients write
 * them to every environment, so the hosted app, which has no primary, reads
 * the first environment that has settings.
 */
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

function activeProjectSpace(input: {
  readonly storedSpaceId: string | null;
  readonly legacySidebarEnabled: boolean;
  readonly environments: ReadonlyArray<ProjectSpaceEnvironment>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly groupingSettings: ReturnType<typeof selectProjectGroupingSettings>;
}) {
  // The legacy sidebar hides the rail's spaces, so none may filter behind it.
  const spaceId = input.legacySidebarEnabled ? null : input.storedSpaceId;
  const { groups } = projectGroupsFrom(input.environments, input.primaryEnvironmentId);
  // The configured folder, not the connection-gated one: a disconnected
  // machine's chats still belong in Chats.
  const scratchWorkspaceRootFor = (environmentId: EnvironmentId) =>
    input.environments.find((environment) => environment.environmentId === environmentId)
      ?.serverConfig?.scratchWorkspaceRoot ?? null;
  const space = resolveProjectSpace(spaceId, groups);
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

/** The rail's selected space, with the project filters it implies. */
export function useActiveProjectSpace() {
  const { environments } = useEnvironments();
  return activeProjectSpace({
    storedSpaceId: useUiStateStore((store) => store.sidebarProjectSpaceId),
    legacySidebarEnabled: useLegacySidebarEnabled(),
    environments,
    primaryEnvironmentId: usePrimaryEnvironmentId(),
    groupingSettings: useClientSettings(selectProjectGroupingSettings),
  });
}

/** The rail's space read at call time, for handlers outside React. */
export function readActiveProjectSpace() {
  const settings = getClientSettings();
  return activeProjectSpace({
    storedSpaceId: useUiStateStore.getState().sidebarProjectSpaceId,
    // Pre-hydration settings are the defaults, where the legacy sidebar is off.
    legacySidebarEnabled: settings.legacySidebarEnabled,
    environments: [...appAtomRegistry.get(environmentPresentations.presentationsAtom)].map(
      ([environmentId, presentation]) => ({ ...presentation, environmentId }),
    ),
    primaryEnvironmentId: readPrimaryEnvironmentId(),
    groupingSettings: selectProjectGroupingSettings(settings),
  });
}
