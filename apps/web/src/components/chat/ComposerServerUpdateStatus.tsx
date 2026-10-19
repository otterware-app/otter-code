import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { CircleAlertIcon, DownloadIcon } from "~/lib/icons";
import { useId, useState } from "react";

import { serverUpdateStageLabel } from "../ServerUpdateAction";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";

// Static on purpose: the title says when an update is running, and spinners repaint every frame.
export function ComposerServerUpdateIcon({
  status,
}: {
  readonly status: ServerUpdateState["status"];
}) {
  if (status === "failed") {
    return <CircleAlertIcon aria-hidden className="text-error" />;
  }
  return <DownloadIcon aria-hidden />;
}
