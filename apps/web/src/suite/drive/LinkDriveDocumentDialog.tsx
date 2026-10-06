import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { type DriveDocumentSummary, parseDriveUrl } from "@t3tools/contracts/suite";
import { Atom } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Spinner } from "../../components/ui/spinner";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { DriveDocumentKindIcon } from "./DriveDocumentKindIcon";
import { driveDocuments, useDriveDocumentLinking, useDriveStatus } from "./driveState";

/**
 * Which thread has the dialog open. Entry points (command palette, the
 * documents panel) set it and the chat view renders the dialog once, so it
 * outlives a palette that closes as its command runs. Like Linear's.
 */
const linkDriveDocumentDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("suite:drive:link-dialog-thread"),
);

export function openLinkDriveDocumentDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(linkDriveDocumentDialogThreadAtom, threadRef);
}

/** Mounted once per chat view; shows the dialog for whichever thread asked for it. */
export function LinkDriveDocumentDialogHost() {
  const threadRef = useAtomValue(linkDriveDocumentDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <LinkDriveDocumentDialog
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(linkDriveDocumentDialogThreadAtom, null)}
    />
  );
}

function LinkDriveDocumentDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const linking = useDriveDocumentLinking();
  const { environmentId, status } = useDriveStatus();
  const connected = status?.status === "connected";
  const baseUrl = status?.baseUrl;
  const parsed = useMemo(() => parseDriveUrl(value, baseUrl), [baseUrl, value]);
  const linkable = parsed !== null && parsed.type !== "folder";
  // Not a link: search the user's recent documents by title instead.
  const query = linkable ? "" : value.trim();
  const documents = useEnvironmentQuery(
    environmentId === null || !connected
      ? null
      : driveDocuments({ environmentId, input: { scope: "recent", query } }),
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const link = useCallback(
    async (url: string) => {
      setSubmitError(null);
      setPending(true);
      try {
        await linking.linkDocument(threadRef, url);
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : "Could not link the document.");
        return;
      } finally {
        setPending(false);
      }
      onClose();
    },
    [linking, onClose, threadRef],
  );

  const submit = () => {
    setDirty(true);
    if (linkable) void link(value.trim());
    else if (documents.data?.documents[0]) void link(documents.data.documents[0].url);
  };

  const validation =
    !dirty || linkable || value.trim().length === 0
      ? null
      : parsed?.type === "folder"
        ? "That is a folder. Pick one of its documents."
        : connected
          ? null
          : "Paste a drive.otterware.app document link.";

  return (
    <Dialog open onOpenChange={(next) => (pending || next ? undefined : onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Link Drive document</DialogTitle>
          <DialogDescription>
            Attach an Otter Drive document to this thread to keep it at hand and follow new
            versions.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            ref={inputRef}
            placeholder={
              connected
                ? "Paste a Drive link or search your documents"
                : "https://drive.otterware.app/<folder>/a/<document>"
            }
            value={value}
            onChange={(event) => {
              setDirty(true);
              setValue(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              submit();
            }}
          />
          {(validation ?? submitError) ? (
            <p className="text-destructive text-xs">{validation ?? submitError}</p>
          ) : null}
          {linkable ? null : connected ? (
            <DocumentPicker
              documents={documents.data?.documents ?? null}
              error={documents.error}
              disabled={pending}
              onPick={(document) => void link(document.url)}
            />
          ) : (
            <p className="text-muted-foreground text-xs">
              {status?.status === "pending"
                ? "Finish connecting Otter Drive in Settings → Drive to browse your documents."
                : "Connect Otter Drive in Settings → Drive to browse your documents. Pasted links link either way."}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={submit} disabled={pending || !linkable}>
            {pending ? "Linking..." : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DocumentPicker({
  documents,
  error,
  disabled,
  onPick,
}: {
  readonly documents: ReadonlyArray<DriveDocumentSummary> | null;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly onPick: (document: DriveDocumentSummary) => void;
}) {
  if (documents === null) {
    return error ? (
      <p className="text-muted-foreground text-xs">{error}</p>
    ) : (
      <div className="flex justify-center py-4">
        <Spinner />
      </div>
    );
  }
  if (documents.length === 0)
    return <p className="text-muted-foreground text-xs">No documents match.</p>;
  return (
    <ScrollArea className="max-h-72">
      <ul className="flex flex-col">
        {documents.map((document) => (
          <li key={document.artifactId}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(document)}
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60 disabled:opacity-50"
            >
              <DriveDocumentKindIcon kind={document.kind} />
              <span className="min-w-0 flex-1 truncate text-sm">{document.title}</span>
              <span className="shrink-0 text-2xs text-muted-foreground">
                {document.version === null ? "" : `v${document.version} · `}
                {formatRelativeTimeLabel(document.updatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}
