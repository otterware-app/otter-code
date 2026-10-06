/**
 * Connecting this server to Otter Drive: Drive's device sign-in (a code the
 * user enters on drive.otterware.app), the connected account, and the way out.
 * Used by Settings → Drive and by the Drive page while not connected.
 */
import type { DriveConnectionStatus } from "@t3tools/contracts/suite";
import { ArrowUpRightIcon, CopyIcon, HardDriveIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import { Spinner } from "../../components/ui/spinner";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectDrive, disconnectDrive, useDriveStatus } from "./driveState";
import { openDriveExternally } from "./driveView";

export function useDriveConnectionActions() {
  const { environmentId, status } = useDriveStatus();
  const connect = useAtomCommand(connectDrive, { reportFailure: true });
  const disconnect = useAtomCommand(disconnectDrive, { reportFailure: true });
  const [busy, setBusy] = useState(false);
  const run = (command: typeof connect) => async () => {
    if (environmentId === null) return;
    setBusy(true);
    try {
      await command({ environmentId, input: {} });
    } finally {
      setBusy(false);
    }
  };
  return { environmentId, status, busy, connect: run(connect), disconnect: run(disconnect) };
}

/** The code to enter and where, while the device sign-in waits for approval. */
export function DrivePendingCode({
  status,
}: {
  readonly status: Extract<DriveConnectionStatus, { status: "pending" }>;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-sm text-muted-foreground">
        Enter this code at {new URL(status.verificationUri).host}
        {new URL(status.verificationUri).pathname} and approve Otterware:
      </p>
      <div className="flex items-center gap-2">
        <span className="rounded-md border border-border bg-muted/40 px-3 py-1.5 font-mono text-lg tracking-widest tabular-nums">
          {status.userCode}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Copy code"
          onClick={() => void writeTextToClipboard(status.userCode, "code")}
        >
          <CopyIcon />
        </Button>
      </div>
      <Button size="sm" onClick={() => openDriveExternally(status.verificationUriComplete)}>
        <ArrowUpRightIcon />
        Open sign-in page
      </Button>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner />
        Waiting for approval…
      </p>
    </div>
  );
}

/** The Drive page's empty state while this server has no Drive sign-in. */
export function DriveConnectEmptyState() {
  const { status, busy, connect } = useDriveConnectionActions();
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HardDriveIcon />
        </EmptyMedia>
        <EmptyTitle>Connect Otter Drive</EmptyTitle>
        <EmptyDescription>
          Sign this Otterware server in to Otter Drive to browse your documents here, link them to
          threads, and let agents read and publish them.
        </EmptyDescription>
      </EmptyHeader>
      {status?.status === "pending" ? (
        <DrivePendingCode status={status} />
      ) : (
        <div className="flex flex-col items-center gap-2">
          {status?.status === "error" ? (
            <p className="text-destructive text-xs">{status.message}</p>
          ) : null}
          <Button size="sm" disabled={busy || status === null} onClick={() => void connect()}>
            {busy ? <Spinner /> : null}
            Connect Drive
          </Button>
        </div>
      )}
    </Empty>
  );
}
