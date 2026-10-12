/**
 * `/drive`. On desktop it is Otter Drive itself (a native WebContentsView on its own
 * session) with back/forward/reload and "open in browser"; on the web, and
 * on desktop when the user switches to the list, Otterware's own browser over
 * the server's Drive client. Publishes the open document for the side chat.
 */
import {
  DRIVE_DEFAULT_BASE_URL,
  type DriveDocumentSummary,
  parseDriveUrl,
} from "@t3tools/contracts/suite";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  GlobeIcon,
  ListIcon,
  RefreshCwIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { type ReactNode, useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { Spinner } from "../../components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { SuiteModuleLayout } from "../SuiteModuleLayout";
import { useSuitePageContext } from "../suitePageContext";
import { type DriveBrowseScope, DriveBrowser, DriveBrowserSidebar } from "./DriveBrowser";
import { DriveConnectEmptyState } from "./DriveConnect";
import { useDriveStatus } from "./driveState";
import { openDriveExternally, useDriveViewStore } from "./driveView";
import { useDriveNativeDocument } from "./useDriveNativeDocument";
import { DriveWebview, useDriveWebview } from "./DriveWebview";

const DrivePageModeSchema = Schema.Literals(["drive", "list"]);
type DrivePageMode = typeof DrivePageModeSchema.Type;

function HeaderButton({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function DrivePage({ requestedUrl }: { readonly requestedUrl: string | null }) {
  const [storedMode, setMode] = useLocalStorage(
    "otterware:drive:page-mode",
    "drive" as DrivePageMode,
    DrivePageModeSchema,
  );
  const requested = useDriveViewStore((state) => state.requested);
  useEffect(() => {
    if (isElectron && (requested || requestedUrl)) setMode("drive");
  }, [requested, requestedUrl, setMode]);
  const mode: DrivePageMode = isElectron ? storedMode : "list";
  const modeToggle = isElectron ? (
    <HeaderButton
      label={mode === "drive" ? "Show as list" : "Show Otter Drive"}
      onClick={() => setMode(mode === "drive" ? "list" : "drive")}
    >
      {mode === "drive" ? <ListIcon /> : <GlobeIcon />}
    </HeaderButton>
  ) : null;
  return mode === "drive" ? (
    <DriveViewPage requestedUrl={requestedUrl} modeToggle={modeToggle} />
  ) : (
    <DriveListPage requestedUrl={requestedUrl} modeToggle={modeToggle} />
  );
}

function DriveViewPage({
  requestedUrl,
  modeToggle,
}: {
  readonly requestedUrl: string | null;
  readonly modeToggle: ReactNode;
}) {
  const { status } = useDriveStatus();
  const webview = useDriveWebview(status?.baseUrl ?? DRIVE_DEFAULT_BASE_URL);
  const current = useDriveViewStore((state) => state.current);
  const [initialUrl] = useState(
    () =>
      requestedUrl ??
      useDriveViewStore.getState().requested?.url ??
      useDriveViewStore.getState().current?.url ??
      `${status?.baseUrl ?? DRIVE_DEFAULT_BASE_URL}/home`,
  );
  // A `?url=` that arrives while the page is already open (Home, links).
  useEffect(() => {
    if (requestedUrl && requestedUrl !== initialUrl)
      useDriveViewStore.getState().request(requestedUrl);
  }, [initialUrl, requestedUrl]);

  const target = current ? parseDriveUrl(current.url, status?.baseUrl) : null;
  const document = useDriveNativeDocument(current?.url ?? null, webview.navigation.loading);
  useSuitePageContext({
    module: "drive",
    title: current?.title ? `Drive · ${current.title}` : "Drive",
    refs:
      current && target?.type === "document"
        ? [
            {
              kind: "drive.document",
              id: document?.artifactId ?? target.reference,
              label: current.title.replace(/ [·|–-] Otter Drive$/u, ""),
              href: current.url,
            },
          ]
        : current
          ? [{ kind: "drive.page", id: current.url, label: current.title, href: current.url }]
          : [],
  });

  return (
    <SuiteModuleLayout
      moduleId="drive"
      headerActions={
        <div className="flex items-center gap-0.5">
          <HeaderButton
            label="Back"
            disabled={!webview.navigation.canGoBack}
            onClick={webview.goBack}
          >
            <ArrowLeftIcon />
          </HeaderButton>
          <HeaderButton
            label="Forward"
            disabled={!webview.navigation.canGoForward}
            onClick={webview.goForward}
          >
            <ArrowRightIcon />
          </HeaderButton>
          <HeaderButton label="Reload" onClick={webview.reload}>
            {webview.navigation.loading ? <Spinner /> : <RefreshCwIcon />}
          </HeaderButton>
          <HeaderButton
            label="Open in browser"
            disabled={current === null}
            onClick={() => current && openDriveExternally(current.url)}
          >
            <ArrowUpRightIcon />
          </HeaderButton>
          {modeToggle}
        </div>
      }
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <DriveWebview initialUrl={initialUrl} webviewRef={webview.ref} />
        {webview.navigation.failed ? (
          <div className="absolute inset-0 flex bg-background">
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyTitle>Otter Drive didn't load</EmptyTitle>
                <EmptyDescription>{webview.navigation.failed}</EmptyDescription>
              </EmptyHeader>
              <Button size="sm" variant="outline" onClick={webview.reload}>
                <RefreshCwIcon />
                Try again
              </Button>
            </Empty>
          </div>
        ) : null}
      </div>
    </SuiteModuleLayout>
  );
}

function DriveListPage({
  requestedUrl,
  modeToggle,
}: {
  readonly requestedUrl: string | null;
  readonly modeToggle: ReactNode;
}) {
  const { environmentId, status } = useDriveStatus();
  const [scope, setScope] = useState<DriveBrowseScope>({ type: "recent" });
  const [selection, setSelection] = useState<{
    url: string | null;
    document: DriveDocumentSummary | null;
  }>({
    url: requestedUrl,
    document: null,
  });
  const selected =
    selection.url === requestedUrl ? (selection.document ?? requestedUrl) : requestedUrl;
  const setSelected = (document: DriveDocumentSummary) =>
    setSelection({ url: requestedUrl, document });
  const connected = status?.status === "connected";
  const selectedReference =
    selected === null ? null : typeof selected === "string" ? selected : selected.artifactId;
  const selectedUrl =
    selected === null ? null : typeof selected === "string" ? selected : selected.url;

  useSuitePageContext({
    module: "drive",
    title: typeof selected === "object" && selected ? `Drive · ${selected.title}` : "Drive",
    refs:
      selected === null
        ? []
        : typeof selected === "string"
          ? [{ kind: "drive.document", id: selected, href: selected }]
          : [
              {
                kind: "drive.document",
                id: selected.artifactId,
                label: selected.title,
                href: selected.url,
              },
            ],
  });

  return (
    <SuiteModuleLayout
      moduleId="drive"
      sidebar={
        environmentId !== null && connected ? (
          <DriveBrowserSidebar environmentId={environmentId} scope={scope} onScope={setScope} />
        ) : undefined
      }
      headerActions={
        <div className="flex items-center gap-0.5">
          <HeaderButton
            label="Open in Otter Drive"
            onClick={() =>
              openDriveExternally(
                selectedUrl ?? `${status?.baseUrl ?? DRIVE_DEFAULT_BASE_URL}/home`,
              )
            }
          >
            <ArrowUpRightIcon />
          </HeaderButton>
          {modeToggle}
        </div>
      }
    >
      {environmentId === null || status === null ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : connected ? (
        <DriveBrowser
          environmentId={environmentId}
          scope={scope}
          selected={selectedReference}
          onSelect={setSelected}
        />
      ) : (
        <DriveConnectEmptyState />
      )}
    </SuiteModuleLayout>
  );
}
