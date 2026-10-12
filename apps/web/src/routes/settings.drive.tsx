import { createFileRoute } from "@tanstack/react-router";

import { DriveSettingsPanel } from "../suite/drive/DriveSettings";

export const Route = createFileRoute("/settings/drive")({ component: DriveSettingsPanel });
