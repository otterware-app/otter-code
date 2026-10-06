import type { EnvironmentId, ProjectGroupSetting } from "@t3tools/contracts";
import { selectProjectGroupingSettings } from "../logicalProject";
import { projectSpaceFilter, resolveProjectSpace } from "../projectSpaces";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useUiStateStore } from "../uiStateStore";
import { useClientSettings, useLegacySidebarEnabled } from "./useSettings";
const NO_GROUPS: ReadonlyArray<ProjectGroupSetting> = [];
/**
 * The project groups, as the primary environment holds them. Clients write
 * them to every environment, so the hosted app, which has no primary, reads
 * the first environment that has settings.
 */
export function useProjectGroups(): {
  readonly groups: ReadonlyArray<ProjectGroupSetting>;
  readonly sourceEnvironmentId: EnvironmentId | null;
} {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return (() => {
    const source =
      environments.find(
        (environment) =>
          environment.environmentId === primaryEnvironmentId && environment.serverConfig,
      ) ?? environments.find((environment) => environment.serverConfig);
    return {
      groups: source?.serverConfig?.settings.railProjectGroups ?? NO_GROUPS,
      sourceEnvironmentId: source?.environmentId ?? null,
    };
  })();
}
/** The rail's selected space, with the project filters it implies. */
export function useActiveProjectSpace() {
  const storedSpaceId = useUiStateStore((store) => store.sidebarProjectSpaceId);
  // The legacy sidebar hides the rail's spaces, so none may filter behind it.
  const spaceId = useLegacySidebarEnabled() ? null : storedSpaceId;
  const { groups } = useProjectGroups();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const { environments } = useEnvironments();
  // The configured folder, not the connection-gated one: a disconnected
  // machine's chats still belong in Chats.
  const scratchWorkspaceRootFor = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.scratchWorkspaceRoot ?? null;
  return (() => {
    const space = resolveProjectSpace(spaceId, groups);
    return {
      space,
      projectFilter: projectSpaceFilter({
        space,
        groups,
        groupingSettings,
        scratchWorkspaceRootFor,
      }),
    };
  })();
}
