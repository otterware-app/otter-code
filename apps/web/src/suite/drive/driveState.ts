/**
 * Drive data in the web app: the connection status, documents read through
 * the server's Drive client, and every thread's linked documents (one stream
 * per environment, re-sent whole on change; there are few links).
 */
import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { type DriveThreadLink, SUITE_DRIVE_METHODS } from "@t3tools/contracts/suite";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { suiteHasModule, useSuiteCapabilities } from "../useSuiteCapabilities";

export const driveStatusChanges = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  { label: "environment-data:suite:drive:status", tag: SUITE_DRIVE_METHODS.subscribeStatus },
);

export const driveThreadLinkChanges = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  { label: "environment-data:suite:drive:links", tag: SUITE_DRIVE_METHODS.subscribeThreadLinks },
);

export const driveFolders = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:suite:drive:folders",
  tag: SUITE_DRIVE_METHODS.listFolders,
  staleTimeMs: 60_000,
  idleTtlMs: 5 * 60_000,
});

export const driveDocuments = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:suite:drive:documents",
  tag: SUITE_DRIVE_METHODS.listDocuments,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

/** A document's page beside a thread or on /drive; re-read on an interval while open. */
export const driveDocumentDetail = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:suite:drive:document-detail",
  tag: SUITE_DRIVE_METHODS.documentDetail,
  staleTimeMs: 15_000,
  refreshIntervalMs: 60_000,
  idleTtlMs: 60_000,
});

export const linkDriveDocument = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Link Drive document",
  tag: SUITE_DRIVE_METHODS.linkDocument,
});
export const unlinkDriveDocument = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Unlink Drive document",
  tag: SUITE_DRIVE_METHODS.unlinkDocument,
});
export const connectDrive = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Connect Otter Drive",
  tag: SUITE_DRIVE_METHODS.connect,
});
export const disconnectDrive = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Disconnect Otter Drive",
  tag: SUITE_DRIVE_METHODS.disconnect,
});
export const markDriveDocumentViewed = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Mark Drive document viewed",
  tag: SUITE_DRIVE_METHODS.markViewed,
});

const EMPTY_LINKS = Atom.make(
  AsyncResult.initial<{ links: ReadonlyArray<DriveThreadLink> }, never>(false),
).pipe(Atom.withLabel("suite:drive:links:none"));
const EMPTY_STATUS = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("suite:drive:status:none"),
);
const NO_LINKS: ReadonlyArray<DriveThreadLink> = [];

/**
 * The environment that runs the Drive module, or null. Links live in the
 * Otterware server's suite.sqlite, so only the primary environment has them;
 * a plain Otter Code environment shows no Drive affordances at all.
 */
export function useDriveEnvironmentId(): EnvironmentId | null {
  const environmentId = usePrimaryEnvironmentId();
  const capabilities = useSuiteCapabilities();
  return environmentId !== null &&
    capabilities.status === "available" &&
    suiteHasModule(capabilities, "drive")
    ? environmentId
    : null;
}

/** Whether `threadRef`'s environment links Drive documents. */
export function useDriveThreadSupported(threadRef: ScopedThreadRef | null): boolean {
  const environmentId = useDriveEnvironmentId();
  return threadRef !== null && environmentId !== null && threadRef.environmentId === environmentId;
}

/** Every link in the Drive environment, live. */
export function useAllDriveThreadLinks(): {
  readonly environmentId: EnvironmentId | null;
  readonly links: ReadonlyArray<DriveThreadLink>;
} {
  const environmentId = useDriveEnvironmentId();
  const result = useAtomValue(
    environmentId === null ? EMPTY_LINKS : driveThreadLinkChanges({ environmentId, input: {} }),
  );
  const links = Option.getOrNull(AsyncResult.value(result))?.links ?? NO_LINKS;
  return { environmentId, links };
}

/** The documents linked to one thread, in link order. */
export function useDriveThreadLinks(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<DriveThreadLink> {
  const { environmentId, links } = useAllDriveThreadLinks();
  const threadId = threadRef?.threadId ?? null;
  const supported = threadRef !== null && threadRef.environmentId === environmentId;
  return useMemo(
    () => (supported ? links.filter((link) => link.threadId === threadId) : NO_LINKS),
    [links, supported, threadId],
  );
}

export function useDriveStatus() {
  const environmentId = useDriveEnvironmentId();
  const result = useAtomValue(
    environmentId === null ? EMPTY_STATUS : driveStatusChanges({ environmentId, input: {} }),
  );
  return { environmentId, status: Option.getOrNull(AsyncResult.value(result)) };
}

/** Link and unlink Drive documents on threads of the Drive environment. */
export function useDriveDocumentLinking() {
  const environmentId = useDriveEnvironmentId();
  const link = useAtomCommand(linkDriveDocument, { reportFailure: false });
  const unlink = useAtomCommand(unlinkDriveDocument, { reportFailure: true });
  return useMemo(() => {
    /** Rejects with a readable error so the link dialog can show it inline. */
    const linkDocument = async (threadRef: ScopedThreadRef, url: string) => {
      if (environmentId === null || threadRef.environmentId !== environmentId)
        throw new Error("This environment does not link Drive documents.");
      const result = await link({
        environmentId,
        input: { threadId: threadRef.threadId, url, source: "manual" },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) throw new Error("Link update interrupted.");
        throw squashAtomCommandFailure(result);
      }
      return result.value;
    };
    const unlinkDocument = (threadRef: ScopedThreadRef, linkId: string) => {
      void unlink({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, linkId },
      });
    };
    return { supported: environmentId !== null, linkDocument, unlinkDocument };
  }, [environmentId, link, unlink]);
}
