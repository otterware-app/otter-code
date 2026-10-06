/**
 * Spaces are what the rail offers: All projects, Chats (threads without a
 * project), and the user's project groups. A space decides which threads the
 * sidebar lists and which projects a new thread is offered in.
 */
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectGroupSetting } from "@t3tools/contracts";

import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "./logicalProject";

export const CHATS_SPACE_ID = "chats";

export type ProjectSpace =
  | { readonly kind: "all"; readonly id: null; readonly name: string }
  | { readonly kind: "chats"; readonly id: typeof CHATS_SPACE_ID; readonly name: string }
  | { readonly kind: "group"; readonly id: string; readonly name: string };

export const ALL_PROJECTS_SPACE: ProjectSpace = { kind: "all", id: null, name: "All projects" };
export const CHATS_SPACE: ProjectSpace = { kind: "chats", id: CHATS_SPACE_ID, name: "Chats" };

export type ProjectSpaceProject = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity"
>;

/** A space id that names no group (one deleted elsewhere) falls back to all projects. */
export function resolveProjectSpace(
  spaceId: string | null,
  groups: ReadonlyArray<ProjectGroupSetting>,
): ProjectSpace {
  if (spaceId === CHATS_SPACE_ID) return CHATS_SPACE;
  const group = spaceId === null ? undefined : groups.find((entry) => entry.id === spaceId);
  return group ? { kind: "group", id: group.id, name: group.name } : ALL_PROJECTS_SPACE;
}

/**
 * Which projects belong to the space, or null for every project. Chats holds
 * each machine's no-project home; a group holds its member projects. The
 * sidebar lists their threads, and new threads default to one of them.
 */
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
    memberKeys.has(deriveLogicalProjectKeyFromSettings(project, input.groupingSettings));
}
