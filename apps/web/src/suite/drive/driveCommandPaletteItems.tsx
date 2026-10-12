import type { ScopedThreadRef } from "@t3tools/contracts";
import { HardDriveIcon } from "lucide-react";

import type { CommandPaletteActionItem } from "../../components/CommandPalette.logic";
import { ITEM_ICON_CLASS } from "../../components/CommandPalette.logic";
import { useRightPanelStore } from "../../rightPanelStore";
import { useDriveThreadLinks, useDriveThreadSupported } from "./driveState";
import { openLinkDriveDocumentDialog } from "./LinkDriveDocumentDialog";

/** "Link Drive document" and "Show linked Drive documents" for the active thread. */
export function useDriveCommandPaletteItems(
  threadRef: ScopedThreadRef | null,
): CommandPaletteActionItem[] {
  const supported = useDriveThreadSupported(threadRef);
  const links = useDriveThreadLinks(threadRef);
  if (threadRef === null || !supported) return [];
  return [
    {
      kind: "action",
      value: "action:link-drive-document",
      searchTerms: ["link", "drive", "document", "doc", "file", "otter drive", "attach"],
      title: "Link Drive document to thread",
      icon: <HardDriveIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openLinkDriveDocumentDialog(threadRef);
      },
    },
    {
      kind: "action",
      value: "action:open-thread-drive-documents",
      searchTerms: ["show", "open", "view", "drive", "documents", "linked", "docs", "files"],
      title: "Show linked Drive documents",
      disabled: links.length === 0,
      icon: <HardDriveIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        useRightPanelStore.getState().open(threadRef, "drive-documents");
      },
    },
  ];
}
