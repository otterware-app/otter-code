import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ALL_PROJECTS_SPACE,
  CHATS_SPACE,
  CHATS_SPACE_ID,
  projectSpaceFilter,
  resolveProjectSpace,
  type ProjectSpaceProject,
} from "./projectSpaces";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");

function project(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  canonicalKey?: string,
): ProjectSpaceProject {
  return {
    environmentId,
    id: ProjectId.make(`${environmentId}:${workspaceRoot}`),
    workspaceRoot,
    repositoryIdentity: canonicalKey
      ? {
          canonicalKey,
          locator: { source: "git-remote", remoteName: "origin", remoteUrl: canonicalKey },
        }
      : null,
  };
}

const groups = [
  { id: "zentio", name: "Zentio", projectKeys: ["github.com/zentio/app"] },
  { id: "empty", name: "Empty", projectKeys: [] },
];
const groupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};
const scratchWorkspaceRootFor = (environmentId: EnvironmentId) =>
  environmentId === laptop ? "/Users/me/.t3/scratch" : null;

describe("resolveProjectSpace", () => {
  it("falls back to all projects for a group that no longer exists", () => {
    expect(resolveProjectSpace(null, groups)).toBe(ALL_PROJECTS_SPACE);
    expect(resolveProjectSpace(CHATS_SPACE_ID, groups)).toBe(CHATS_SPACE);
    expect(resolveProjectSpace("zentio", groups)).toEqual({
      kind: "group",
      id: "zentio",
      name: "Zentio",
    });
    expect(resolveProjectSpace("deleted", groups)).toBe(ALL_PROJECTS_SPACE);
  });
});

describe("projectSpaceFilter", () => {
  const zentioOnLaptop = project(laptop, "/Users/me/zentio", "github.com/zentio/app");
  const zentioOnServer = project(server, "/srv/zentio", "github.com/zentio/app");
  const otter = project(laptop, "/Users/me/otter", "github.com/otterware/otter");
  const scratch = project(laptop, "/Users/me/.t3/scratch");

  it("keeps every project in All projects", () => {
    expect(
      projectSpaceFilter({
        space: ALL_PROJECTS_SPACE,
        groups,
        groupingSettings,
        scratchWorkspaceRootFor,
      }),
    ).toBeNull();
  });

  it("holds a group's repository on every machine", () => {
    const filter = projectSpaceFilter({
      space: resolveProjectSpace("zentio", groups),
      groups,
      groupingSettings,
      scratchWorkspaceRootFor,
    });
    expect([zentioOnLaptop, zentioOnServer, otter, scratch].filter(filter!)).toEqual([
      zentioOnLaptop,
      zentioOnServer,
    ]);
  });

  it("holds only the machines' no-project homes in Chats", () => {
    const filter = projectSpaceFilter({
      space: CHATS_SPACE,
      groups,
      groupingSettings,
      scratchWorkspaceRootFor,
    });
    expect([zentioOnLaptop, otter, scratch].filter(filter!)).toEqual([scratch]);
  });

  it("holds nothing in an empty group", () => {
    const filter = projectSpaceFilter({
      space: resolveProjectSpace("empty", groups),
      groups,
      groupingSettings,
      scratchWorkspaceRootFor,
    });
    expect([zentioOnLaptop, otter, scratch].filter(filter!)).toEqual([]);
  });
});
