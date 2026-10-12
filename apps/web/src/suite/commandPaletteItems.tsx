import type { useNavigate } from "@tanstack/react-router";

import type { CommandPaletteActionItem } from "../components/CommandPalette.logic";
import { ITEM_ICON_CLASS } from "../components/CommandPalette.logic";
import { SUITE_WEB_MODULES } from "./modules";

/** "Go to Home/Mail/Calendar/Drive" entries for the command palette. */
export function suiteCommandPaletteItems(
  navigate: ReturnType<typeof useNavigate>,
): CommandPaletteActionItem[] {
  return SUITE_WEB_MODULES.map((module) => {
    const Icon = module.icon;
    return {
      kind: "action",
      value: `action:suite:${module.id}`,
      searchTerms: ["go to", ...module.searchTerms],
      title: `Go to ${module.label}`,
      icon: <Icon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: module.path });
      },
    };
  });
}
