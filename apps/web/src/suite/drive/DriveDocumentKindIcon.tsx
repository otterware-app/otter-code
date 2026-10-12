import type { DriveDocumentKind } from "@t3tools/contracts/suite";
import {
  FileCodeIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  type LucideIcon,
  SheetIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";

const KIND_ICONS: Record<DriveDocumentKind, LucideIcon> = {
  markdown: FileTextIcon,
  text: FileTextIcon,
  csv: SheetIcon,
  tsv: SheetIcon,
  workbook: FileSpreadsheetIcon,
  video: FileVideoIcon,
  frame: FileCodeIcon,
};

export const DRIVE_KIND_LABELS: Record<DriveDocumentKind, string> = {
  markdown: "Markdown",
  text: "Text",
  csv: "CSV",
  tsv: "TSV",
  workbook: "Workbook",
  video: "Video",
  frame: "Page",
};

/** A Drive document's format, as Drive files it; a plain file before the first sync. */
export function DriveDocumentKindIcon({
  kind,
  className,
}: {
  readonly kind: DriveDocumentKind | null;
  readonly className?: string;
}) {
  const Icon = kind === null ? FileIcon : KIND_ICONS[kind];
  return <Icon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}
