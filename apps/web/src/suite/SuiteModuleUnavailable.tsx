import { CloudOffIcon } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";

/**
 * Shown when the connected environment does not run this module: a plain
 * Otter Code server (`plainServer`), or an Otterware server without it.
 */
export function SuiteModuleUnavailable({
  label,
  plainServer,
}: {
  readonly label: string;
  readonly plainServer: boolean;
}) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CloudOffIcon />
        </EmptyMedia>
        <EmptyTitle>{label} isn’t available here</EmptyTitle>
        <EmptyDescription>
          {plainServer
            ? `This environment runs Otter Code without Otterware. Connect to an Otterware environment to use ${label}.`
            : `This Otterware environment doesn’t run ${label} yet.`}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
