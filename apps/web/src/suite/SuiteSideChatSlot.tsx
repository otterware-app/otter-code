/**
 * The right-hand side chat on module pages: a compact Code thread that sees
 * what the page publishes through `useSuitePageContext` (see
 * `sideChat/SuiteSideChat.tsx`). Open state and width persist; ⌘J / Ctrl+J
 * toggles it while a module page is shown.
 */
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { RightPanelResizeHandle } from "../components/preview/RightPanelResizeHandle";
import { isMacPlatform } from "../lib/utils";
import { SuiteSideChat } from "./sideChat/SuiteSideChat";

const SIDE_CHAT_OPEN_KEY = "otterware:suite-side-chat:open:v1";
const SIDE_CHAT_WIDTH_KEY = "otterware:suite-side-chat:width:v1";

const isMac = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);
export const SIDE_CHAT_SHORTCUT_LABEL = isMac ? "⌘J" : "Ctrl+J";

/** Shared by the slot and the page header's toggle. */
export function useSuiteSideChatOpen() {
  return useLocalStorage(SIDE_CHAT_OPEN_KEY, true, Schema.Boolean);
}

/** ⌘J / Ctrl+J toggles the side chat. Module pages do not mount Code's terminal shortcut. */
export function useSuiteSideChatShortcut(enabled: boolean) {
  const [open, setOpen] = useSuiteSideChatOpen();
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "j") return;
      if (!(isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      setOpen(!open);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, open, setOpen]);
}

export function SuiteSideChatSlot({ moduleId }: { readonly moduleId: string }) {
  const [open, setOpen] = useSuiteSideChatOpen();
  const { width, handlers } = useResizableWidth({
    storageKey: SIDE_CHAT_WIDTH_KEY,
    defaultWidth: 380,
    minWidth: 300,
    maxWidth: 720,
    edge: "left",
  });
  if (!open) return null;

  return (
    <aside
      aria-label="Side chat"
      data-suite-side-chat=""
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-background"
      style={{ width }}
    >
      <RightPanelResizeHandle handlers={handlers} />
      <SuiteSideChat
        moduleId={moduleId}
        onHide={() => setOpen(false)}
        hideShortcutLabel={SIDE_CHAT_SHORTCUT_LABEL}
      />
    </aside>
  );
}
