/**
 * A thread's linked Drive documents, the way its Linear issues show: a badge
 * in the sidebar row, a list in the right panel, and one document's page.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { type DriveThreadLink, driveThreadLinkTitle } from "@t3tools/contracts/suite";
import {
  ArrowUpRightIcon,
  HardDriveIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PlusIcon,
  UnlinkIcon,
} from "lucide-react";
import { type MouseEvent, useCallback } from "react";

import { Button, InlineButton } from "../../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { shouldOpenPullRequestExternally } from "../../lib/openPullRequestLink";
import { useRightPanelStore } from "../../rightPanelStore";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { DriveDocumentKindIcon } from "./DriveDocumentKindIcon";
import { useDriveDocumentLinking, useDriveThreadLinks } from "./driveState";
import { useOpenDriveUrl } from "./driveView";
import { openLinkDriveDocumentDialog } from "./LinkDriveDocumentDialog";

const SOURCE_LABELS: Record<DriveThreadLink["source"], string> = {
  manual: "Linked by you",
  agent: "Linked by the agent",
};

const SYNC_LABELS: Record<DriveThreadLink["syncState"], string | null> = {
  pending: "Not synced yet",
  synced: null,
  not_connected: "Drive not connected",
  not_found: "Not found in Drive",
  unavailable: "Drive unreachable",
};

/** The reference a document page is keyed by: its id once known, else its URL. */
export function driveLinkReference(link: DriveThreadLink): string {
  return link.artifactId !== null &&
    link.version === null &&
    !new URL(link.url).searchParams.has("sheet")
    ? link.artifactId
    : link.url;
}

/** Opens one document's page beside the thread, or the list when there are several. */
export function openThreadDriveDocuments(
  threadRef: ScopedThreadRef,
  links: ReadonlyArray<DriveThreadLink>,
): void {
  const panel = useRightPanelStore.getState();
  const [only, ...others] = links;
  if (only && others.length === 0) {
    panel.openDriveDocument(threadRef, {
      reference: driveLinkReference(only),
      title: driveThreadLinkTitle(only),
    });
  } else {
    panel.open(threadRef, "drive-documents");
  }
}

/**
 * The sidebar row's Drive badge: a drive glyph and the count, with a dot when
 * a linked document has a version the user has not looked at. Click opens the
 * document (or the list); cmd/ctrl-click opens the first one in Drive.
 */
export function ThreadDriveDocumentsBadge({
  threadRef,
  onActivate,
}: {
  readonly threadRef: ScopedThreadRef;
  /** Selects the row's thread, so the panel opens beside it. */
  readonly onActivate: () => void;
}) {
  const links = useDriveThreadLinks(threadRef);
  const openDriveUrl = useOpenDriveUrl();
  if (links.length === 0) return null;
  const changed = links.some((link) => link.changed);
  const label = `${links.length} linked Drive document${links.length === 1 ? "" : "s"}${changed ? ", updated" : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <InlineButton
            tone="muted"
            aria-label={label}
            onPointerDown={(event: MouseEvent<HTMLElement>) => event.stopPropagation()}
            onClick={(event: MouseEvent<HTMLElement>) => {
              event.stopPropagation();
              event.preventDefault();
              if (shouldOpenPullRequestExternally(event)) {
                openDriveUrl(links[0]!.url);
                return;
              }
              openThreadDriveDocuments(threadRef, links);
              onActivate();
            }}
          />
        }
      >
        <span className="relative mr-0.5 inline-flex">
          <HardDriveIcon className="size-3" />
          {changed ? (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-info"
            />
          ) : null}
        </span>
        <span className="font-normal text-xs tabular-nums">{links.length}</span>
      </TooltipTrigger>
      <TooltipPopup
        side="top"
        sideOffset={0}
        variant="glass"
        className="w-72 max-w-[calc(100vw-2rem)] text-left whitespace-normal"
      >
        <ul className="flex flex-col gap-1">
          {links.map((link) => (
            <li key={link.id} className="flex min-w-0 items-center gap-2 px-1 py-0.5">
              <DriveDocumentKindIcon kind={link.snapshot?.kind ?? null} />
              <span className="min-w-0 truncate text-foreground/75">
                {driveThreadLinkTitle(link)}
              </span>
              <span className="ml-auto shrink-0 pl-1 text-3xs">
                {link.changed
                  ? "Updated"
                  : link.snapshot?.version != null
                    ? `v${link.snapshot.version}`
                    : (SYNC_LABELS[link.syncState] ?? "")}
              </span>
            </li>
          ))}
        </ul>
      </TooltipPopup>
    </Tooltip>
  );
}

function DocumentRow({
  threadRef,
  link,
  onUnlink,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly link: DriveThreadLink;
  readonly onUnlink: ((link: DriveThreadLink) => void) | null;
}) {
  const openDriveUrl = useOpenDriveUrl();
  const snapshot = link.snapshot;
  const syncLabel = SYNC_LABELS[link.syncState];
  return (
    <div className="group/drive-row flex w-full items-center gap-2 rounded-md py-1 pr-1 pl-2 hover:bg-accent/60">
      <DriveDocumentKindIcon kind={snapshot?.kind ?? null} />
      <a
        href={link.url}
        onClick={(event) => {
          event.preventDefault();
          if (shouldOpenPullRequestExternally(event)) {
            openDriveUrl(link.url);
            return;
          }
          useRightPanelStore.getState().openDriveDocument(threadRef, {
            reference: driveLinkReference(link),
            title: driveThreadLinkTitle(link),
          });
        }}
        className="flex min-w-0 flex-1 flex-col"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm">{driveThreadLinkTitle(link)}</span>
          {link.changed ? (
            <span className="shrink-0 rounded-full bg-info/12 px-1.5 text-2xs text-info-foreground">
              Updated
            </span>
          ) : null}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          {snapshot?.version != null ? (
            <span className="shrink-0">
              {link.version !== null ? `v${link.version} (pinned)` : `v${snapshot.version}`}
            </span>
          ) : null}
          {snapshot?.updatedBy ? <span className="truncate">· {snapshot.updatedBy}</span> : null}
          {syncLabel ? <span className="truncate">{syncLabel}</span> : null}
          <span className="ml-auto shrink-0">
            {SOURCE_LABELS[link.source]} · {formatRelativeTimeLabel(link.linkedAt)}
          </span>
        </span>
      </a>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-micro"
              aria-label={`Actions for ${driveThreadLinkTitle(link)}`}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          }
        />
        <MenuPopup align="end" side="bottom">
          <MenuItem onClick={() => void writeTextToClipboard(link.url, "link")}>
            <LinkIcon className="size-3.5" />
            Copy link
          </MenuItem>
          <MenuItem onClick={() => openDriveUrl(link.url)}>
            <ArrowUpRightIcon className="size-3.5" />
            Open in Drive
          </MenuItem>
          {onUnlink ? (
            <MenuItem onClick={() => onUnlink(link)}>
              <UnlinkIcon className="size-3.5" />
              Unlink from thread
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** The thread's linked Drive documents, with the version Drive last reported for each. */
export function ThreadDriveDocumentsPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const links = useDriveThreadLinks(threadRef);
  const linking = useDriveDocumentLinking();
  const openLinkDialog = useCallback(() => openLinkDriveDocumentDialog(threadRef), [threadRef]);
  const handleUnlink = useCallback(
    (link: DriveThreadLink) => linking.unlinkDocument(threadRef, link.id),
    [linking, threadRef],
  );

  if (links.length === 0) {
    return (
      <Empty className="min-h-0 justify-center-safe">
        <EmptyMedia variant="icon">
          <HardDriveIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No linked Drive documents</EmptyTitle>
          <EmptyDescription>
            {linking.supported
              ? "Documents the agent works on land here. Link one yourself by its Drive link."
              : "This environment does not run Otterware's Drive module."}
          </EmptyDescription>
        </EmptyHeader>
        {linking.supported ? (
          <Button size="sm" variant="outline" onClick={openLinkDialog}>
            <PlusIcon className="size-3.5" />
            Link Drive document
          </Button>
        ) : null}
      </Empty>
    );
  }

  let lastSynced: string | null = null;
  for (const link of links) {
    const at = link.snapshot?.syncedAt;
    if (at !== undefined && (lastSynced === null || at > lastSynced)) lastSynced = at;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col p-1.5">
          {links.map((link) => (
            <DocumentRow
              key={link.id}
              threadRef={threadRef}
              link={link}
              onUnlink={linking.supported ? handleUnlink : null}
            />
          ))}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
        <span>
          {links.length} linked
          {lastSynced
            ? ` · synced ${formatRelativeTimeLabel(lastSynced)}`
            : " · not synced with Drive yet"}
        </span>
        {linking.supported ? (
          <Button size="xs" variant="ghost" onClick={openLinkDialog}>
            <PlusIcon className="size-3.5" />
            Link
          </Button>
        ) : null}
      </footer>
    </div>
  );
}
