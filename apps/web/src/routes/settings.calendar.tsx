import { createFileRoute } from "@tanstack/react-router";

import { CalendarSettingsSection } from "../suite/calendar/CalendarSettingsSection";

export const Route = createFileRoute("/settings/calendar")({ component: CalendarSettingsSection });
