/**
 * Otterware's own view of Drive, read through this server's Drive client: the
 * web build's Drive page (Drive cannot be framed there) and the desktop's
 * "list" mode. Folders and Shared on the left, documents in the middle, the
 * selected document's page on the right.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { DriveDocumentSummary, DriveListDocumentsInput } from "@t3tools/contracts/suite";
import { ClockIcon, FolderIcon, HardDriveIcon, SearchIcon, UsersIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../components/ui/input-group";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Spinner } from "../../components/ui/spinner";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { DriveDocumentDetail } from "./DriveDocumentDetail";
import { DriveDocumentKindIcon } from "./DriveDocumentKindIcon";
import { driveDocuments, driveFolders } from "./driveState";

export type DriveBrowseScope =
  | { readonly type: "recent" }
  | { readonly type: "shared" }
  | { readonly type: "folder"; readonly folderId: string; readonly name: string };

function NavButton({
  active,
  icon,
  label,
  onClick,
  indent = 0,
}: {
  readonly active: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
  readonly indent?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ paddingLeft: `${0.5 + indent * 0.75}rem` }}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md py-1 pr-2 text-left text-sm hover:bg-accent/60",
        active && "bg-accent text-foreground",
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

/** The module sidebar: where to look. */
export function DriveBrowserSidebar({
  environmentId,
  scope,
  onScope,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: DriveBrowseScope;
  readonly onScope: (scope: DriveBrowseScope) => void;
}) {
  const folders = useEnvironmentQuery(driveFolders({ environmentId, input: {} }));
  const list = folders.data?.folders ?? [];
  const depth = (parentId: string | null, seen = 0): number => {
    if (parentId === null || seen > 8) return 0;
    const parent = list.find((folder) => folder.id === parentId);
    return parent ? 1 + depth(parent.parentId, seen + 1) : 0;
  };
  return (
    <div className="flex flex-col gap-0.5 p-2">
      <NavButton
        active={scope.type === "recent"}
        icon={<ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />}
        label="Recent"
        onClick={() => onScope({ type: "recent" })}
      />
      <NavButton
        active={scope.type === "shared"}
        icon={<UsersIcon className="size-3.5 shrink-0 text-muted-foreground" />}
        label="Shared with me"
        onClick={() => onScope({ type: "shared" })}
      />
      <h2 className="mt-3 mb-1 px-2 text-xs font-medium text-muted-foreground">Drives</h2>
      {folders.data === null && !folders.error ? (
        <div className="flex justify-center py-2">
          <Spinner />
        </div>
      ) : null}
      {list.map((folder) => (
        <NavButton
          key={folder.id}
          active={scope.type === "folder" && scope.folderId === folder.id}
          icon={
            folder.parentId === null ? (
              <HardDriveIcon className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
            )
          }
          label={folder.name}
          indent={depth(folder.parentId)}
          onClick={() => onScope({ type: "folder", folderId: folder.id, name: folder.name })}
        />
      ))}
    </div>
  );
}

function listInput(scope: DriveBrowseScope, query: string): DriveListDocumentsInput {
  const trimmed = query.trim();
  return {
    scope: scope.type,
    ...(scope.type === "folder" ? { folderId: scope.folderId } : {}),
    ...(trimmed ? { query: trimmed } : {}),
  };
}

export function DriveBrowser({
  environmentId,
  scope,
  selected,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: DriveBrowseScope;
  /** Artifact id or Drive URL of the open document. */
  readonly selected: string | null;
  readonly onSelect: (document: DriveDocumentSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const documents = useEnvironmentQuery(
    driveDocuments({ environmentId, input: listInput(scope, query) }),
  );
  const list = documents.data?.documents ?? null;
  const title =
    scope.type === "recent" ? "Recent" : scope.type === "shared" ? "Shared with me" : scope.name;

  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex w-80 shrink-0 flex-col border-r border-border">
        <div className="flex flex-col gap-2 border-b border-border/60 p-3">
          <h2 className="text-sm font-medium">{title}</h2>
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon aria-hidden className="size-3" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search documents"
              placeholder="Search by title"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {list === null ? (
            documents.error ? (
              <p className="p-4 text-sm text-muted-foreground">{documents.error}</p>
            ) : (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            )
          ) : list.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {query.trim() ? "No documents match." : "No documents here yet."}
            </p>
          ) : (
            <ul className="flex flex-col p-1.5">
              {list.map((document) => (
                <li key={document.artifactId}>
                  <button
                    type="button"
                    onClick={() => onSelect(document)}
                    className={cn(
                      "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60",
                      (selected === document.artifactId || selected === document.url) &&
                        "bg-accent",
                    )}
                  >
                    <DriveDocumentKindIcon kind={document.kind} className="mt-0.5" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{document.title}</span>
                      <span className="truncate text-2xs text-muted-foreground">
                        {document.version === null ? "Draft" : `v${document.version}`}
                        {document.updatedBy ? ` · ${document.updatedBy}` : ""} ·{" "}
                        {formatRelativeTimeLabel(document.updatedAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </section>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected ? (
          <DriveDocumentDetail key={selected} environmentId={environmentId} reference={selected} />
        ) : (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>Pick a document</EmptyTitle>
              <EmptyDescription>
                Its versions and a preview show here. Open it in Drive to edit.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>
    </div>
  );
}
