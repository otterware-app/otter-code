"use client";

import type { DesktopPreviewExtensionAction, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, EyeOff, MoreVertical, Pin, PinOff, Puzzle, Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import {
  CHROME_WEB_STORE_URL,
  previewExtensions,
  useOpenExtensionTabs,
  usePreviewExtensionActions,
  usePreviewExtensionsUi,
} from "~/browser/previewExtensions";
import { openUrlInPreview } from "~/browser/openFileInPreview";
import { recordVisitForThread } from "~/browserHistoryStore";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

interface Props {
  threadRef: ScopedThreadRef;
  /** The tab's guest, once the desktop has one: extensions act on it. */
  webContentsId: number | null;
  /** Whether this preview is the one showing; only it opens the pages extensions ask for. */
  visible: boolean;
}

function ActionIcon({ action }: { action: DesktopPreviewExtensionAction }) {
  return (
    <span className="relative flex size-4 shrink-0 items-center justify-center">
      {action.icon ? (
        <img src={action.icon} alt="" className={cn("size-4", !action.enabled && "opacity-40")} />
      ) : (
        <Puzzle className="size-4 text-muted-foreground" />
      )}
      {action.badgeText ? (
        <span
          className="absolute -bottom-1.5 -right-2 min-w-3.5 rounded-xs px-0.5 text-center text-3xs font-semibold leading-3.25"
          style={{ background: action.badgeBackgroundColor, color: action.badgeTextColor }}
        >
          {action.badgeText.slice(0, 4)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The extensions' end of the preview's toolbar, as in Otter Mail (and
 * Chrome): pinned extensions' buttons, then the Extensions menu listing them
 * all, to run, pin, or manage. A popup hangs from the button clicked.
 */
export function PreviewExtensionToolbar({ threadRef, webContentsId, visible }: Props) {
  const actions = usePreviewExtensionActions(webContentsId);
  const pinned = usePreviewExtensionsUi((state) => state.pinned);
  const setPinned = usePreviewExtensionsUi((state) => state.setPinned);
  const showButton = usePreviewExtensionsUi((state) => state.extensionsButton);
  const setExtensionsButton = usePreviewExtensionsUi((state) => state.setExtensionsButton);
  const navigate = useNavigate();
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  // The preview showing is Chrome's active tab, and gets the pages extensions open.
  useEffect(() => {
    if (visible && webContentsId !== null) {
      void previewExtensions?.setActiveTab(webContentsId).catch(() => undefined);
    }
  }, [visible, webContentsId]);
  // A tab beside this thread, as Chrome opens one beside the current tab.
  const openTab = useCallback(
    (url: string) =>
      void openUrlInPreview({ threadRef, url, openPreview }).then((result) => {
        if (result._tag === "Success") recordVisitForThread(threadRef, url);
      }),
    [openPreview, threadRef],
  );
  useOpenExtensionTabs(visible ? openTab : null);

  if (!previewExtensions) return null;
  const bridge = previewExtensions;

  const run = (extensionId: string, anchor: Element | null) => {
    const rect = anchor?.getBoundingClientRect();
    if (!rect || webContentsId === null) return;
    void bridge
      .runAction({
        extensionId,
        webContentsId,
        anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      })
      .catch(() => undefined);
  };

  const onToolbar = pinned
    .map((id) => actions.find((action) => action.id === id))
    .filter((action): action is DesktopPreviewExtensionAction => action !== undefined);
  const manage = () => void navigate({ to: "/settings/extensions" });
  if (onToolbar.length === 0 && !showButton) return null;

  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-foreground/[0.06] p-0.5 [--control-radius:9999px]">
      {onToolbar.map((action) => (
        <Tooltip key={action.id}>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                aria-label={action.title}
                disabled={webContentsId === null}
                onClick={(event) => run(action.id, event.currentTarget)}
              />
            }
          >
            <ActionIcon action={action} />
          </TooltipTrigger>
          <TooltipPopup>{action.title}</TooltipPopup>
        </Tooltip>
      ))}
      {showButton ? (
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  ref={menuButtonRef}
                  render={
                    <Button variant="ghost" size="icon-xs" type="button" aria-label="Extensions" />
                  }
                />
              }
            >
              <Puzzle />
            </TooltipTrigger>
            <TooltipPopup>Extensions</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end" sideOffset={6} className="w-80">
            <MenuGroup>
              <MenuGroupLabel>Extensions ({actions.length})</MenuGroupLabel>
              {actions.length === 0 ? (
                <p className="px-2 pb-1.5 text-xs text-muted-foreground">
                  None yet. Add one from the Chrome Web Store.
                </p>
              ) : null}
              {actions.map((action) => {
                const isPinned = pinned.includes(action.id);
                return (
                  <div key={action.id} className="flex items-center gap-0.5">
                    <MenuItem
                      className="min-w-0 flex-1"
                      disabled={webContentsId === null}
                      onClick={() => run(action.id, menuButtonRef.current)}
                    >
                      <ActionIcon action={action} />
                      <span className="truncate">{action.name}</span>
                    </MenuItem>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant={isPinned ? "ghost" : "ghost-muted"}
                            size="icon-xs"
                            type="button"
                            aria-label={isPinned ? `Unpin ${action.name}` : `Pin ${action.name}`}
                            aria-pressed={isPinned}
                            onClick={() => setPinned(action.id, !isPinned)}
                          />
                        }
                      >
                        <Pin className={cn(isPinned && "fill-current")} />
                      </TooltipTrigger>
                      <TooltipPopup>{isPinned ? "Unpin" : "Pin to toolbar"}</TooltipPopup>
                    </Tooltip>
                    <MenuSub>
                      <MenuSubTrigger
                        aria-label={`More for ${action.name}`}
                        className="shrink-0 [&>svg:last-child]:hidden"
                      >
                        <MoreVertical />
                      </MenuSubTrigger>
                      <MenuSubPopup>
                        {action.hasOptions ? (
                          <MenuItem
                            onClick={() =>
                              void bridge.openOptions(action.id).catch(() => undefined)
                            }
                          >
                            <Settings2 />
                            Options
                          </MenuItem>
                        ) : null}
                        <MenuItem onClick={() => setPinned(action.id, !isPinned)}>
                          {isPinned ? <PinOff /> : <Pin />}
                          {isPinned ? "Unpin" : "Pin to toolbar"}
                        </MenuItem>
                        <MenuItem onClick={manage}>
                          <Puzzle />
                          Manage extension
                        </MenuItem>
                      </MenuSubPopup>
                    </MenuSub>
                  </div>
                );
              })}
            </MenuGroup>
            <MenuSeparator />
            <MenuItem onClick={manage}>
              Manage extensions
              <ArrowUpRight className="ms-auto" />
            </MenuItem>
            <MenuItem onClick={() => openTab(CHROME_WEB_STORE_URL)}>
              Visit Web Store
              <ArrowUpRight className="ms-auto" />
            </MenuItem>
            <MenuItem onClick={() => setExtensionsButton(false)}>
              Hide from toolbar
              <EyeOff className="ms-auto" />
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}
