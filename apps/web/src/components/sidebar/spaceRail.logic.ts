import type { ProjectGroupSetting } from "@t3tools/contracts";
import { LEGACY_VOID_SPACE_ID, type ProjectSpace } from "../../projectSpaces";

export const RAIL_ITEM_IDS = ["home", "spaces", "pullRequests", "automations"] as const;
export type RailItemId = (typeof RAIL_ITEM_IDS)[number];
export const RAIL_ITEM_LABELS: Readonly<Record<RailItemId, string>> = {
  home: "Home",
  spaces: "Spaces",
  pullRequests: "Code review",
  automations: "Automations",
};

function isRailItemId(value: string): value is RailItemId {
  return RAIL_ITEM_IDS.some((id) => id === value);
}

export function normalizeRailItemOrder(order: ReadonlyArray<string>): RailItemId[] {
  return [...new Set([...order.filter(isRailItemId), ...RAIL_ITEM_IDS])];
}

export function normalizeHiddenRailItems(hidden: ReadonlyArray<string>): RailItemId[] {
  return [...new Set(hidden.filter((id) => isRailItemId(id) && id !== "home"))].filter(
    isRailItemId,
  );
}

export function visibleRailItems(input: {
  order: ReadonlyArray<string>;
  hidden: ReadonlyArray<string>;
  activeItem: RailItemId | null;
  pullRequestsSupported: boolean;
}): RailItemId[] {
  const hidden = new Set(normalizeHiddenRailItems(input.hidden));
  return normalizeRailItemOrder(input.order).filter(
    (id) =>
      (id !== "pullRequests" || input.pullRequestsSupported) &&
      (!hidden.has(id) || input.activeItem === id),
  );
}

export type RailShortcut =
  | { kind: "space"; key: string; spaceId: string }
  | { kind: "project"; key: string; projectKey: string };

export const railSpaceShortcutKey = (spaceId: string) => `space:${spaceId}`;
export const railProjectShortcutKey = (projectKey: string) => `project:${projectKey}`;

export function pruneRemovedRailShortcuts(keys: ReadonlyArray<string>): string[] {
  return keys.filter((key) => key !== railSpaceShortcutKey(LEGACY_VOID_SPACE_ID));
}

export function resolveRailShortcuts(input: {
  keys: ReadonlyArray<string>;
  spaceIds: ReadonlySet<string>;
  projectKeys: ReadonlySet<string>;
}): RailShortcut[] {
  return [...new Set(pruneRemovedRailShortcuts(input.keys))].flatMap((key): RailShortcut[] => {
    if (key.startsWith("space:")) {
      const spaceId = key.slice("space:".length);
      return input.spaceIds.has(spaceId) ? [{ kind: "space", key, spaceId }] : [];
    }
    if (key.startsWith("project:")) {
      const projectKey = key.slice("project:".length);
      return input.projectKeys.has(projectKey) ? [{ kind: "project", key, projectKey }] : [];
    }
    return [];
  });
}

export function toggleRailShortcut(keys: ReadonlyArray<string>, key: string): string[] {
  return keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key];
}

export function reorderRailKeys(
  keys: ReadonlyArray<string>,
  activeId: string,
  overId: string,
): ReadonlyArray<string> {
  const from = keys.indexOf(activeId);
  const to = keys.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return keys;
  const next = [...keys];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

export function projectRailSpaceId(input: {
  projectKey: string;
  spaces: ReadonlyArray<ProjectGroupSetting>;
  activeSpaceId: string | null;
}): string | null {
  const memberships = input.spaces.filter((space) => space.projectKeys.includes(input.projectKey));
  return (
    (memberships.find((space) => space.id === input.activeSpaceId) ?? memberships[0])?.id ?? null
  );
}

export function activeRailShortcutKey(input: {
  threadsShowing: boolean;
  space: ProjectSpace;
  projectScopeKey: string | null;
  shortcuts: ReadonlyArray<RailShortcut>;
}): string | null {
  if (!input.threadsShowing) return null;
  if (input.projectScopeKey !== null)
    return (
      input.shortcuts.find(
        (shortcut) => shortcut.kind === "project" && shortcut.projectKey === input.projectScopeKey,
      )?.key ?? null
    );
  if (input.space.kind === "all") return null;
  return (
    input.shortcuts.find(
      (shortcut) => shortcut.kind === "space" && shortcut.spaceId === input.space.id,
    )?.key ?? null
  );
}
