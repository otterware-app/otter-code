import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ALL_PROJECTS_SPACE,
  LEGACY_VOID_SPACE_ID,
  CHATS_SPACE,
  CHATS_SPACE_ID,
  projectSpaceFilter,
  projectSpaceIcon,
  moveProjectToSpace,
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
  it.each([null, undefined, "deleted", LEGACY_VOID_SPACE_ID])(
    "keeps global aggregation without an explicit Space: %s",
    (spaceId) => {
      expect(resolveProjectSpace(spaceId, groups)).toBe(ALL_PROJECTS_SPACE);
    },
  );

  it("distinguishes Chats and named Spaces from the global view", () => {
    expect(resolveProjectSpace(CHATS_SPACE_ID, groups)).toBe(CHATS_SPACE);
    expect(resolveProjectSpace("zentio", groups)).toEqual({
      kind: "group",
      id: "zentio",
      name: "Zentio",
    });
  });
});

describe("projectSpaceFilter", () => {
  const zentioOnLaptop = project(laptop, "/Users/me/zentio", "github.com/zentio/app");
  const zentioOnServer = project(server, "/srv/zentio", "github.com/zentio/app");
  const otter = project(laptop, "/Users/me/otter", "github.com/otterware/otter");
  const scratch = project(laptop, "/Users/me/.t3/scratch");

  it("aggregates assigned, unassigned, remote and no-project activity with no Space selected", () => {
    expect(
      projectSpaceFilter({
        space: resolveProjectSpace(null, groups),
        groups,
        groupingSettings,
        scratchWorkspaceRootFor,
      }),
    ).toBeNull();
  });

  it("returns a removed built-in Space selection to all projects without a hidden filter", () => {
    const filter = projectSpaceFilter({
      space: resolveProjectSpace(LEGACY_VOID_SPACE_ID, groups),
      groups,
      groupingSettings,
      scratchWorkspaceRootFor,
    });
    expect(filter).toBeNull();
  });

  it("returns a deleted Space to global aggregation on every environment", () => {
    const filter = projectSpaceFilter({
      space: resolveProjectSpace("zentio", []),
      groups: [],
      groupingSettings,
      scratchWorkspaceRootFor,
    });
    expect(filter).toBeNull();
  });

  it("holds an explicitly selected Space's repository on every machine", () => {
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

describe("moveProjectToSpace", () => {
  it("moves one repository into a single Space while preserving IDs, icons and offline members", () => {
    const spaces = [
      { id: "one", name: "One", icon: "rocket", projectKeys: ["repo", "offline"] },
      { id: "two", name: "Two", projectKeys: ["other"] },
    ];
    expect(moveProjectToSpace(spaces, "repo", "two")).toEqual([
      { ...spaces[0], projectKeys: ["offline"] },
      { ...spaces[1], projectKeys: ["other", "repo"] },
    ]);
    expect(moveProjectToSpace(spaces, "repo", null)).toEqual([
      { ...spaces[0], projectKeys: ["offline"] },
      spaces[1],
    ]);
  });

  it("does not remove membership when a destination was deleted on another device", () => {
    expect(moveProjectToSpace(groups, "github.com/zentio/app", "deleted")).toBe(groups);
  });
});

describe("projectSpaceIcon", () => {
  it("provides the default icon for migrated groups and unknown icons", () => {
    expect(projectSpaceIcon({})).toBe("bag");
    expect(projectSpaceIcon({ icon: "missing" })).toBe("bag");
    expect(projectSpaceIcon({ icon: "rocket" })).toBe("rocket");
  });
});
