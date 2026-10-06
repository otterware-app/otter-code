/**
 * `../CommandPalette.logic` for the vendored calendar (a manifest import remap). Otter
 * Calendar's palette lets an action run synchronously and marks groups `searchOnly`; Otter
 * Code's wants `run` to return a promise. `toPaletteGroups` adapts the calendar's groups.
 */
import type {
  CommandPaletteItem,
  CommandPaletteActionItem as PaletteActionItem,
  CommandPaletteGroup as PaletteGroup,
  CommandPaletteSubmenuItem,
} from "../../../components/CommandPalette.logic";

export * from "../../../components/CommandPalette.logic";

export interface CommandPaletteActionItem extends CommandPaletteItem {
  readonly kind: "action";
  readonly keepOpen?: boolean;
  readonly run: () => Promise<void> | void;
}

export interface CommandPaletteGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
  /** Only listed once the user types (Otter Calendar's palette); see `useSuiteCommandPaletteGroups`. */
  readonly searchOnly?: boolean;
}

const toPaletteItem = (
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem,
): PaletteActionItem | CommandPaletteSubmenuItem =>
  item.kind === "submenu"
    ? item
    : {
        ...item,
        run: async () => {
          await item.run();
        },
      };

export function toPaletteGroups(
  groups: ReadonlyArray<CommandPaletteGroup>,
  query: string,
): PaletteGroup[] {
  return groups
    .filter((group) => group.searchOnly !== true || query.trim().length > 0)
    .map(({ searchOnly: _searchOnly, ...group }) => ({
      ...group,
      items: group.items.map(toPaletteItem),
    }));
}
