import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectGroupSetting } from "@t3tools/contracts";

import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "./logicalProject";

export const CHATS_SPACE_ID = "chats";
export const LEGACY_VOID_SPACE_ID = "__void__";

export type ProjectSpace =
  | { readonly kind: "all"; readonly id: null; readonly name: string }
  | { readonly kind: "chats"; readonly id: typeof CHATS_SPACE_ID; readonly name: string }
  | { readonly kind: "group"; readonly id: string; readonly name: string };

export const ALL_PROJECTS_SPACE: ProjectSpace = { kind: "all", id: null, name: "All projects" };
export const CHATS_SPACE: ProjectSpace = { kind: "chats", id: CHATS_SPACE_ID, name: "Chats" };

export const SPACE_ICON_OPTIONS = [
  { name: "bag", label: "Bag" },
  { name: "home", label: "Home" },
  { name: "code-brackets", label: "Code" },
  { name: "rocket", label: "Rocket" },
  { name: "light-bulb", label: "Idea" },
  { name: "color-palette", label: "Palette" },
  { name: "book", label: "Book" },
  { name: "lab", label: "Lab" },
  { name: "heart", label: "Heart" },
  { name: "star", label: "Star" },
  { name: "globe", label: "Globe" },
  { name: "cloud", label: "Cloud" },
  { name: "hammer", label: "Hammer" },
  { name: "chart-2", label: "Chart" },
  { name: "gamecontroller", label: "Games" },
  { name: "camera-1", label: "Camera" },
  { name: "target", label: "Target" },
  { name: "tree", label: "Tree" },
  { name: "school", label: "School" },
  { name: "backpack", label: "Backpack" },
] as const;

export function projectSpaceIcon(group: Pick<ProjectGroupSetting, "icon">): string {
  return SPACE_ICON_OPTIONS.find((option) => option.name === group.icon)?.name ?? "bag";
}

/** Moving files a logical project into one Space, across all of its environments. */
export function moveProjectToSpace(
  groups: ReadonlyArray<ProjectGroupSetting>,
  projectKey: string,
  destinationId: string | null,
): ReadonlyArray<ProjectGroupSetting> {
  if (destinationId !== null && !groups.some((group) => group.id === destinationId)) return groups;
  return groups.map((group) => ({
    ...group,
    projectKeys:
      group.id === destinationId
        ? [...group.projectKeys.filter((key) => key !== projectKey), projectKey]
        : group.projectKeys.filter((key) => key !== projectKey),
  }));
}

export type ProjectSpaceProject = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity"
>;

export function normalizeProjectSpaceId(spaceId: string | null | undefined): string | null {
  return spaceId == null || spaceId === LEGACY_VOID_SPACE_ID ? null : spaceId;
}

/** Home aggregates every project until the user explicitly selects a Space. */
export function resolveProjectSpace(
  spaceId: string | null | undefined,
  groups: ReadonlyArray<ProjectGroupSetting>,
): ProjectSpace {
  const normalizedId = normalizeProjectSpaceId(spaceId);
  if (normalizedId === CHATS_SPACE_ID) return CHATS_SPACE;
  const group =
    normalizedId === null ? undefined : groups.find((entry) => entry.id === normalizedId);
  if (group) return { kind: "group", id: group.id, name: group.name };
  return ALL_PROJECTS_SPACE;
}

/** Chats keeps each machine's no-project home outside named project Spaces. */
export function projectSpaceFilter(input: {
  readonly space: ProjectSpace;
  readonly groups: ReadonlyArray<ProjectGroupSetting>;
  readonly groupingSettings: ProjectGroupingSettings;
  readonly scratchWorkspaceRootFor: (environmentId: EnvironmentId) => string | null;
}): ((project: ProjectSpaceProject) => boolean) | null {
  const { space } = input;
  if (space.kind === "all") return null;
  if (space.kind === "chats") {
    return (project) =>
      isScratchProject(project, input.scratchWorkspaceRootFor(project.environmentId));
  }
  const memberKeys = new Set(
    input.groups.find((group) => group.id === space.id)?.projectKeys ?? [],
  );
  return (project) =>
    !isScratchProject(project, input.scratchWorkspaceRootFor(project.environmentId)) &&
    memberKeys.has(deriveLogicalProjectKeyFromSettings(project, input.groupingSettings));
}
