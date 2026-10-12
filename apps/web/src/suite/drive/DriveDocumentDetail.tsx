/**
 * One Drive document, read through this server's Drive connection: what it
 * is, who changed it, a preview of text documents, and its versions. Shown
 * beside a thread (right panel) and on the web Drive page.
 */
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  type DriveDocumentDetail as DriveDocumentDetailData,
  type DriveDocumentSummary,
  type DriveThreadLink,
  driveThreadLinkTitle,
} from "@t3tools/contracts/suite";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  LinkIcon,
  MoreHorizontalIcon,
  QuoteIcon,
  RefreshCwIcon,
  UnlinkIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Spinner } from "../../components/ui/spinner";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { DRIVE_KIND_LABELS, DriveDocumentKindIcon } from "./DriveDocumentKindIcon";
import { driveDocumentDetail, markDriveDocumentViewed } from "./driveState";
import { useOpenDriveUrl } from "./driveView";

export function DriveDocumentDetail({
  environmentId,
  reference,
  threadRef,
  link,
  onBack,
  onUnlink,
  onCite,
}: {
  readonly environmentId: EnvironmentId;
  /** Artifact id or Drive URL. */
  readonly reference: string;
  readonly threadRef?: ScopedThreadRef | null;
  /** The thread's link to it, for its last snapshot while Drive is unreachable. */
  readonly link?: DriveThreadLink | null;
  readonly onBack?: (() => void) | undefined;
  readonly onUnlink?: (() => void) | undefined;
  /** Puts a link to the document (and any selected preview text) into the thread's composer. */
  readonly onCite?: ((markdown: string) => void) | undefined;
}) {
  const [version, setVersion] = useState<number | null>(null);
  const query = useEnvironmentQuery(
    driveDocumentDetail({
      environmentId,
      input: version === null ? { reference } : { reference, version },
    }),
  );
  const detail = query.data;
  const markViewed = useAtomCommand(markDriveDocumentViewed, { reportFailure: false });
  const markedRef = useRef<string | null>(null);
  // Opening the page is looking at it: the current version stops being "new". Once per version.
  useEffect(() => {
    if (!detail) return;
    const seenVersion =
      detail.preview.type === "text" ? detail.preview.version : detail.document.version;
    const selected = version ?? link?.version;
    if (detail.preview.type !== "text" && selected != null && selected !== seenVersion) return;
    if (seenVersion === null) return;
    if (detail.viewedVersion !== null && detail.viewedVersion >= seenVersion) return;
    const key = `${detail.document.artifactId}:${seenVersion}`;
    if (markedRef.current === key) return;
    markedRef.current = key;
    void markViewed({
      environmentId,
      input: { artifactId: detail.document.artifactId, version: seenVersion },
    });
  }, [detail, environmentId, link?.version, markViewed, version]);

  if (detail === null) {
    if (!query.error) {
      return (
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      );
    }
    return (
      <UnavailableState
        message={query.error}
        notConnected={(query.failure as { reason?: string } | null)?.reason === "not_connected"}
        link={link ?? null}
        url={link?.url ?? (reference.startsWith("http") ? reference : null)}
        onRetry={query.refresh}
        onBack={onBack}
        onUnlink={onUnlink}
      />
    );
  }

  return (
    <DetailBody
      detail={detail}
      threadRef={threadRef ?? null}
      environmentId={environmentId}
      refreshing={query.isPending}
      readAt={query.dataUpdatedAt}
      selectedVersion={version ?? link?.version ?? null}
      sheet={reference.startsWith("http") ? new URL(reference).searchParams.get("sheet") : null}
      onSelectVersion={setVersion}
      onRefresh={query.refresh}
      onBack={onBack}
      onUnlink={onUnlink}
      onCite={onCite}
    />
  );
}

function DetailBody({
  detail,
  threadRef,
  environmentId,
  refreshing,
  readAt,
  selectedVersion,
  sheet,
  onSelectVersion,
  onRefresh,
  onBack,
  onUnlink,
  onCite,
}: {
  readonly detail: DriveDocumentDetailData;
  readonly threadRef: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId;
  readonly refreshing: boolean;
  readonly readAt: number;
  readonly selectedVersion: number | null;
  readonly sheet: string | null;
  readonly onSelectVersion: (version: number | null) => void;
  readonly onRefresh: () => void;
  readonly onBack: (() => void) | undefined;
  readonly onUnlink: (() => void) | undefined;
  readonly onCite: ((markdown: string) => void) | undefined;
}) {
  const { document, preview, versions, viewedVersion } = detail;
  const previewRef = useRef<HTMLDivElement>(null);
  const isNew =
    document.version !== null && viewedVersion !== null && document.version > viewedVersion;
  const previewVersion =
    preview.type === "text" ? preview.version : (selectedVersion ?? document.version);
  const url = new URL(document.url);
  if (previewVersion !== null && previewVersion !== document.version)
    url.pathname += `/v${previewVersion}`;
  if (sheet) url.searchParams.set("sheet", sheet);
  const versionUrl = url.toString();

  const cite = () => {
    if (!onCite) return;
    const selection = window.getSelection();
    const selected =
      selection && previewRef.current?.contains(selection.anchorNode)
        ? selection.toString().trim()
        : "";
    const label = `${document.title}${previewVersion === null ? "" : ` v${previewVersion}`}`;
    const quote = selected
      ? `${selected
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n\n`
      : "";
    onCite(`${quote}[${label}](${versionUrl})`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DocumentHeader
        document={document}
        url={versionUrl}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onBack={onBack}
        onUnlink={onUnlink}
        onCite={onCite ? cite : undefined}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 px-4 pt-2 pb-6">
          <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3">
            <PropertyRow label="Kind">
              <DriveDocumentKindIcon kind={document.kind} />
              <span className="truncate">
                {document.kind ? DRIVE_KIND_LABELS[document.kind] : "Not published"}
              </span>
            </PropertyRow>
            <PropertyRow label="Folder">
              <span className="truncate font-mono text-xs">{document.folderSlug}</span>
            </PropertyRow>
            <PropertyRow label="Version">
              <span className="truncate">
                {document.version === null
                  ? "None yet"
                  : `v${document.version}${document.versionLabel ? ` · ${document.versionLabel}` : ""}`}
              </span>
              {isNew ? (
                <span className="shrink-0 rounded-full bg-info/12 px-1.5 text-2xs text-info-foreground">
                  New since v{viewedVersion}
                </span>
              ) : null}
            </PropertyRow>
            <PropertyRow label="Updated">
              <span className="truncate">
                {document.updatedBy ? `${document.updatedBy} · ` : ""}
                {formatRelativeTimeLabel(document.updatedAt)}
              </span>
            </PropertyRow>
            {document.role ? (
              <PropertyRow label="Access">
                <span className="truncate capitalize">
                  {document.role}
                  {document.shared ? " · shared" : ""}
                </span>
              </PropertyRow>
            ) : null}
          </dl>
          {document.description.trim().length > 0 ? (
            <p className="text-sm text-muted-foreground">{document.description}</p>
          ) : null}
          <Section
            title={
              preview.type === "text" && preview.version !== document.version
                ? `Preview of v${preview.version}`
                : "Preview"
            }
          >
            <div ref={previewRef}>
              {preview.type === "text" ? (
                document.kind === "markdown" ? (
                  <ChatMarkdown
                    text={preview.text}
                    cwd={undefined}
                    threadRef={threadRef ?? undefined}
                    pullRequestPanelRef={threadRef ?? undefined}
                    environmentId={environmentId}
                  />
                ) : (
                  <pre className="max-h-[60vh] overflow-auto rounded-md border border-border/60 bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre">
                    {preview.text}
                  </pre>
                )
              ) : (
                <div className="flex flex-col items-start gap-2">
                  {document.thumbnailUrl && previewVersion === document.version ? (
                    <img
                      src={document.thumbnailUrl}
                      alt=""
                      className="max-h-56 rounded-md border border-border/60 object-contain"
                    />
                  ) : null}
                  <p className="text-sm text-muted-foreground">{preview.reason}</p>
                </div>
              )}
              {preview.type === "text" && preview.truncated ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Showing the beginning. Open it in Drive for the rest.
                </p>
              ) : null}
            </div>
          </Section>
          {versions.length > 0 ? (
            <Section title={`Versions (${versions.length})`}>
              <ul className="flex flex-col">
                {versions.map((entry) => {
                  const active = previewVersion === entry.number;
                  return (
                    <li key={entry.number}>
                      <button
                        type="button"
                        onClick={() => onSelectVersion(entry.number)}
                        className={cn(
                          "flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/60",
                          active && "bg-accent/40",
                        )}
                      >
                        <span className="w-8 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                          v{entry.number}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">{entry.label}</span>
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          {entry.createdBy ? `${entry.createdBy} · ` : ""}
                          {formatRelativeTimeLabel(entry.createdAt)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Section>
          ) : null}
        </div>
      </ScrollArea>
      <footer className="border-t border-border/60 px-3 py-1.5 text-2xs text-muted-foreground">
        {readAt > 0
          ? `Read from Otter Drive ${formatRelativeTimeLabel(new Date(readAt).toISOString())} · updates while open`
          : "Updates while open"}
      </footer>
    </div>
  );
}

function DocumentHeader({
  document,
  url,
  refreshing,
  onRefresh,
  onBack,
  onUnlink,
  onCite,
}: {
  readonly document: DriveDocumentSummary;
  readonly url: string;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly onBack: (() => void) | undefined;
  readonly onUnlink: (() => void) | undefined;
  readonly onCite: (() => void) | undefined;
}) {
  const openDriveUrl = useOpenDriveUrl();
  return (
    <header className="flex flex-col gap-2 border-b border-border/60 px-4 pt-3 pb-3">
      <div className="flex items-center gap-2">
        {onBack ? (
          <Button size="icon-xs" variant="ghost" aria-label="All linked documents" onClick={onBack}>
            <ArrowLeftIcon />
          </Button>
        ) : null}
        <DriveDocumentKindIcon kind={document.kind} />
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {document.folderSlug}/{document.slug}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh from Otter Drive"
            disabled={refreshing}
            onClick={onRefresh}
          >
            {refreshing ? <Spinner /> : <RefreshCwIcon />}
          </Button>
          {onCite ? (
            <Button size="xs" variant="outline" onClick={onCite}>
              <QuoteIcon />
              Cite
            </Button>
          ) : null}
          <Button size="xs" variant="outline" onClick={() => openDriveUrl(url)}>
            <ArrowUpRightIcon />
            Open in Drive
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button size="icon-xs" variant="ghost" aria-label="More document actions">
                  <MoreHorizontalIcon />
                </Button>
              }
            />
            <MenuPopup align="end" side="bottom">
              <MenuItem onClick={() => void writeTextToClipboard(url, "link")}>
                <LinkIcon className="size-3.5" />
                Copy link
              </MenuItem>
              {onUnlink ? (
                <MenuItem onClick={onUnlink}>
                  <UnlinkIcon className="size-3.5" />
                  Unlink from thread
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        </div>
      </div>
      <h2 className="text-base font-medium leading-snug">{document.title}</h2>
    </header>
  );
}

function PropertyRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="contents">
      <dt className="flex h-7 items-center text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-h-7 min-w-0 items-center gap-2 text-sm">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function UnavailableState({
  message,
  notConnected,
  link,
  url,
  onRetry,
  onBack,
  onUnlink,
}: {
  readonly message: string;
  readonly notConnected: boolean;
  readonly link: DriveThreadLink | null;
  readonly url: string | null;
  readonly onRetry: () => void;
  readonly onBack: (() => void) | undefined;
  readonly onUnlink: (() => void) | undefined;
}) {
  const navigate = useNavigate();
  const openDriveUrl = useOpenDriveUrl();
  return (
    <Empty className="min-h-0 justify-center-safe">
      <EmptyHeader>
        <EmptyTitle>
          {link
            ? driveThreadLinkTitle(link)
            : notConnected
              ? "Otter Drive is not connected"
              : "Couldn't load this document"}
        </EmptyTitle>
        <EmptyDescription>
          {notConnected
            ? "Connect Otter Drive to see this document's versions and preview here."
            : message}
          {link?.snapshot
            ? ` Last synced v${link.snapshot.version ?? "–"}, ${formatRelativeTimeLabel(link.snapshot.syncedAt)}.`
            : ""}
        </EmptyDescription>
      </EmptyHeader>
      <div className="flex flex-wrap justify-center gap-2">
        {onBack ? (
          <Button size="sm" variant="ghost" onClick={onBack}>
            <ArrowLeftIcon />
            All documents
          </Button>
        ) : null}
        {notConnected ? (
          <Button size="sm" onClick={() => void navigate({ to: "/settings/drive" })}>
            Connect Drive
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCwIcon />
            Retry
          </Button>
        )}
        {url ? (
          <Button size="sm" variant="outline" onClick={() => openDriveUrl(url)}>
            <ArrowUpRightIcon />
            Open in Drive
          </Button>
        ) : null}
        {onUnlink ? (
          <Button size="sm" variant="ghost" onClick={onUnlink}>
            <UnlinkIcon />
            Unlink
          </Button>
        ) : null}
      </div>
    </Empty>
  );
}
