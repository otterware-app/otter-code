/**
 * `../CommandPaletteResults` for the vendored calendar (a manifest import remap): Otter Code's
 * results list fed with the calendar's palette groups (see `commandPaletteLogic.ts`).
 */
import { type ComponentProps, useMemo } from "react";

import { CommandPaletteResults as PaletteResults } from "../../../components/CommandPaletteResults";
import { type CommandPaletteGroup, toPaletteGroups } from "./commandPaletteLogic";

export function CommandPaletteResults({
  groups,
  isActionsOnly = false,
  query = "",
  ...props
}: Omit<ComponentProps<typeof PaletteResults>, "groups" | "isActionsOnly"> & {
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly isActionsOnly?: boolean;
  readonly query?: string;
}) {
  const paletteGroups = useMemo(() => toPaletteGroups(groups, query), [groups, query]);
  return <PaletteResults {...props} groups={paletteGroups} isActionsOnly={isActionsOnly} />;
}
