/**
 * The hooks ChatView and RightPanelTabs use for Drive, so those upstream files
 * each change by a line or two (like Linear's panels plug in).
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { type RightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { DriveDocumentDetail } from "./DriveDocumentDetail";
import {
  useDriveDocumentLinking,
  useDriveThreadLinks,
  useDriveThreadSupported,
} from "./driveState";
import { driveLinkReference, ThreadDriveDocumentsPanel } from "./ThreadDriveDocuments";

/** The right panel launcher's "Drive documents" entry for the active thread. */
export function useDriveDocumentsLauncher(threadRef: ScopedThreadRef | null) {
  const available = useDriveThreadSupported(threadRef);
  const onAdd = useCallback(() => {
    if (threadRef && available) useRightPanelStore.getState().open(threadRef, "drive-documents");
  }, [available, threadRef]);
  return { available, onAdd };
}

/** Renders the `drive-documents` and `drive-document` surfaces beside a thread. */
export function DriveRightPanelSurface({
  surface,
  threadRef,
  onCite,
}: {
  readonly surface: Extract<RightPanelSurface, { kind: "drive-documents" | "drive-document" }>;
  readonly threadRef: ScopedThreadRef;
  /** Inserts markdown into the thread's composer. */
  readonly onCite?: ((markdown: string) => void) | undefined;
}) {
  const links = useDriveThreadLinks(threadRef);
  const linking = useDriveDocumentLinking();
  if (surface.kind === "drive-documents")
    return <ThreadDriveDocumentsPanel threadRef={threadRef} />;
  const link =
    links.find(
      (entry) =>
        driveLinkReference(entry) === surface.reference ||
        entry.url === surface.reference ||
        entry.artifactId === surface.reference,
    ) ?? null;
  return (
    <DriveDocumentDetail
      key={surface.id}
      environmentId={threadRef.environmentId}
      reference={surface.reference}
      threadRef={threadRef}
      link={link}
      onBack={
        links.length > 1
          ? () => useRightPanelStore.getState().open(threadRef, "drive-documents")
          : undefined
      }
      onUnlink={
        link && linking.supported
          ? () => {
              linking.unlinkDocument(threadRef, link.id);
              useRightPanelStore.getState().closeSurface(threadRef, surface.id);
            }
          : undefined
      }
      onCite={onCite}
    />
  );
}
