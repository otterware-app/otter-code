/** Resolve the native page for side chat and acknowledge the version opened there. */
import { parseDriveUrl } from "@t3tools/contracts/suite";
import { useEffect, useRef } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { driveDocumentDetail, markDriveDocumentViewed, useDriveStatus } from "./driveState";

export function useDriveNativeDocument(url: string | null, loading: boolean) {
  const { environmentId, status } = useDriveStatus();
  const target = url ? parseDriveUrl(url, status?.baseUrl) : null;
  const detail = useEnvironmentQuery(
    url && environmentId && status?.status === "connected" && target?.type === "document"
      ? driveDocumentDetail({ environmentId, input: { reference: url } })
      : null,
  );
  const markViewed = useAtomCommand(markDriveDocumentViewed, { reportFailure: false });
  const seenUrl = useRef<string | null>(null);
  useEffect(() => {
    if (loading || target?.type !== "document") {
      seenUrl.current = null;
      return;
    }
    if (!detail.data || !environmentId || seenUrl.current === url) return;
    const version =
      detail.data.preview.type === "text"
        ? detail.data.preview.version
        : (target.version ?? detail.data.document.version);
    if (version === null) return;
    seenUrl.current = url;
    void markViewed({
      environmentId,
      input: { artifactId: detail.data.document.artifactId, version },
    });
  }, [
    detail.data,
    environmentId,
    loading,
    markViewed,
    target?.type,
    target?.type === "document" ? target.version : null,
    url,
  ]);
  return detail.data?.document ?? null;
}
