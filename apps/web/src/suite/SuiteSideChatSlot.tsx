/**
 * The right-hand slot every module page reserves for the side chat: a compact
 * Code thread that sees what the page publishes through `useSuitePageContext`.
 * This is the placeholder; the side chat itself replaces its body.
 */
import * as Schema from "effect/Schema";
import { MessagesSquareIcon, PanelRightCloseIcon } from "lucide-react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { RightPanelResizeHandle } from "../components/preview/RightPanelResizeHandle";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useCurrentSuitePageContext } from "./suitePageContext";

const SIDE_CHAT_OPEN_KEY = "otterware:suite-side-chat:open:v1";
const SIDE_CHAT_WIDTH_KEY = "otterware:suite-side-chat:width:v1";

/** Shared by the slot and the page header's toggle. */
export function useSuiteSideChatOpen() {
  return useLocalStorage(SIDE_CHAT_OPEN_KEY, true, Schema.Boolean);
}

export function SuiteSideChatSlot() {
  const [open, setOpen] = useSuiteSideChatOpen();
  const { width, handlers } = useResizableWidth({
    storageKey: SIDE_CHAT_WIDTH_KEY,
    defaultWidth: 360,
    minWidth: 280,
    maxWidth: 640,
    edge: "left",
  });
  const pageContext = useCurrentSuitePageContext();
  if (!open) return null;

  return (
    <aside
      aria-label="Side chat"
      data-suite-side-chat=""
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-background"
      style={{ width }}
    >
      <RightPanelResizeHandle handlers={handlers} />
      <div className="flex h-(--workspace-topbar-height) shrink-0 items-center gap-2 border-b border-border px-3">
        <MessagesSquareIcon className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">Side chat</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Hide side chat"
                onClick={() => setOpen(false)}
              />
            }
          >
            <PanelRightCloseIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Hide side chat</TooltipPopup>
        </Tooltip>
      </div>
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessagesSquareIcon />
          </EmptyMedia>
          <EmptyTitle>Ask about this page</EmptyTitle>
          <EmptyDescription>
            {pageContext
              ? `A chat here will see “${pageContext.title}”.`
              : "A chat here will see what you are looking at."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </aside>
  );
}
