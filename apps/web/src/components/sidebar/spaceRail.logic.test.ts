import { describe, expect, it } from "vite-plus/test";
import { ALL_PROJECTS_SPACE, LEGACY_VOID_SPACE_ID, resolveProjectSpace } from "../../projectSpaces";
import {
  activeRailShortcutKey,
  normalizeHiddenRailItems,
  normalizeRailItemOrder,
  projectRailSpaceId,
  pruneRemovedRailShortcuts,
  railProjectShortcutKey,
  railSpaceShortcutKey,
  RAIL_ITEM_IDS,
  reorderRailKeys,
  resolveRailShortcuts,
  toggleRailShortcut,
  visibleRailItems,
} from "./spaceRail.logic";

describe("rail customization", () => {
  it("retains saved order, adds available destinations and removes unsupported or duplicate entries", () => {
    expect(
      normalizeRailItemOrder(["automations", "inbox", "spaces", "spaces", "studio", "unknown"]),
    ).toEqual(["automations", "spaces", "home", "pullRequests"]);
    expect(normalizeRailItemOrder([])).toEqual(RAIL_ITEM_IDS);
  });

  it("keeps Home visible and keeps a hidden destination reachable while it is active", () => {
    expect(normalizeHiddenRailItems(["home", "spaces", "spaces", "inbox", "unknown"])).toEqual([
      "spaces",
    ]);
    expect(
      visibleRailItems({
        order: [],
        hidden: ["home", "spaces", "pullRequests"],
        activeItem: "spaces",
        pullRequestsSupported: true,
      }),
    ).toEqual(["home", "spaces", "automations"]);
    expect(
      visibleRailItems({
        order: [],
        hidden: ["spaces"],
        activeItem: "pullRequests",
        pullRequestsSupported: false,
      }),
    ).toEqual(["home", "automations"]);
  });

  it("reorders without dropping unavailable shortcuts or mutating saved state", () => {
    const keys = ["home", "spaces", "pullRequests", "automations"];
    expect(reorderRailKeys(keys, "automations", "spaces")).toEqual([
      "home",
      "automations",
      "spaces",
      "pullRequests",
    ]);
    expect(keys).toEqual(["home", "spaces", "pullRequests", "automations"]);
    expect(reorderRailKeys(keys, "unknown", "home")).toBe(keys);
  });
});

describe("rail shortcuts", () => {
  const local = railProjectShortcutKey("local:project:shared");
  const remote = railProjectShortcutKey("remote:project:shared");
  const removedKey = railSpaceShortcutKey(LEGACY_VOID_SPACE_ID);
  const work = railSpaceShortcutKey("work");

  it("drops removed built-in shortcuts and preserves distinct scoped project keys", () => {
    expect(
      resolveRailShortcuts({
        keys: [removedKey, local, remote, work, local, "space:deleted", "project:gone", "bad"],
        spaceIds: new Set(["work", LEGACY_VOID_SPACE_ID]),
        projectKeys: new Set(["local:project:shared", "remote:project:shared"]),
      }),
    ).toEqual([
      { kind: "project", key: local, projectKey: "local:project:shared" },
      { kind: "project", key: remote, projectKey: "remote:project:shared" },
      { kind: "space", key: work, spaceId: "work" },
    ]);
  });

  it("pins and unpins without clearing unavailable projects that can reconnect", () => {
    const keys = ["project:offline", local];
    expect(toggleRailShortcut(keys, local)).toEqual(["project:offline"]);
    expect(toggleRailShortcut(keys, work)).toEqual(["project:offline", local, work]);
  });

  it("reorders mixed pinned projects and Spaces while retaining offline shortcut keys", () => {
    const keys = ["project:offline", local, work, remote];
    const reordered = reorderRailKeys(keys, work, local);
    expect(reordered).toEqual(["project:offline", work, local, remote]);
    expect(
      resolveRailShortcuts({
        keys: reordered,
        spaceIds: new Set(["work"]),
        projectKeys: new Set(["local:project:shared", "remote:project:shared"]),
      }).map((shortcut) => shortcut.key),
    ).toEqual([work, local, remote]);
    expect(reorderRailKeys(keys, local, local)).toBe(keys);
    expect(keys).toEqual(["project:offline", local, work, remote]);
  });

  it("migrates retired pins without deleting unavailable project preferences", () => {
    expect(pruneRemovedRailShortcuts([removedKey, "project:offline", work])).toEqual([
      "project:offline",
      work,
    ]);
  });

  it("opens a project in its owning Space while preserving a matching legacy membership", () => {
    const spaces = [
      { id: "first", name: "First", projectKeys: ["repo", "local:project:shared"] },
      { id: "second", name: "Second", projectKeys: ["repo", "remote:project:shared"] },
    ];
    expect(projectRailSpaceId({ projectKey: "repo", spaces, activeSpaceId: "second" })).toBe(
      "second",
    );
    expect(
      projectRailSpaceId({ projectKey: "remote:project:shared", spaces, activeSpaceId: "first" }),
    ).toBe("second");
    expect(
      projectRailSpaceId({ projectKey: "unassigned", spaces, activeSpaceId: "first" }),
    ).toBeNull();
  });

  it("shows Home for the global collection and prioritizes the opened project shortcut", () => {
    const shortcuts = resolveRailShortcuts({
      keys: [removedKey, local],
      spaceIds: new Set(),
      projectKeys: new Set(["local:project:shared"]),
    });
    expect(
      activeRailShortcutKey({
        threadsShowing: true,
        space: ALL_PROJECTS_SPACE,
        projectScopeKey: null,
        shortcuts,
      }),
    ).toBeNull();
    expect(
      activeRailShortcutKey({
        threadsShowing: true,
        space: resolveProjectSpace(LEGACY_VOID_SPACE_ID, []),
        projectScopeKey: null,
        shortcuts,
      }),
    ).toBeNull();
    expect(
      activeRailShortcutKey({
        threadsShowing: true,
        space: ALL_PROJECTS_SPACE,
        projectScopeKey: "local:project:shared",
        shortcuts,
      }),
    ).toBe(local);
    expect(
      activeRailShortcutKey({
        threadsShowing: false,
        space: ALL_PROJECTS_SPACE,
        projectScopeKey: "local:project:shared",
        shortcuts,
      }),
    ).toBeNull();
  });
});
