/** The calendar before any account: connect Google, or look around with demo data. */
import type { CalendarDirectory, EnvironmentId } from "@t3tools/contracts";
import { BRAND } from "@t3tools/shared/brand";
import { Link } from "@tanstack/react-router";
import { CalendarDaysIcon, FlaskConicalIcon } from "lucide-react";
import { useState } from "react";

import { toastCommandFailure } from "../../suite/calendar/upstreamShims/commandFailureToast";
import { calendarEnvironment } from "../../state/calendar";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { useCalendarUi } from "./calendarUiStore";

export function CalendarOnboarding({
  environmentId,
  directory,
}: {
  environmentId: EnvironmentId;
  directory: CalendarDirectory;
}) {
  const openGoogleConnect = useCalendarUi((state) => state.openGoogleConnect);
  const addDemo = useAtomCommand(calendarEnvironment.addDemo, { reportFailure: false });
  const [adding, setAdding] = useState(false);
  const configured = directory.google.configured;
  return (
    <Empty className="flex-1" data-calendar-onboarding="">
      <EmptyHeader>
        <CalendarDaysIcon className="mx-auto mb-3 size-7 text-muted-foreground" aria-hidden />
        <EmptyTitle>Welcome to {BRAND.displayName}</EmptyTitle>
        <EmptyDescription>
          All your Google calendars in one fast view. Connect an account to start, or look around
          with sample calendars first.
        </EmptyDescription>
        <div className="mt-6 flex flex-col items-center gap-2">
          <Button disabled={!configured} onClick={() => openGoogleConnect()}>
            Connect a Google account
          </Button>
          {configured ? null : (
            <p className="max-w-80 text-xs text-muted-foreground">
              Google sign-in needs an OAuth client on this environment first. Add one in{" "}
              <Link
                to="/settings/calendar"
                className="text-foreground underline underline-offset-2"
              >
                Calendar settings
              </Link>
              .
            </p>
          )}
          <Button
            variant="outline"
            disabled={adding}
            onClick={async () => {
              setAdding(true);
              const result = await addDemo({ environmentId, input: { size: "standard" } });
              setAdding(false);
              toastCommandFailure("Could not add demo data", result);
            }}
          >
            <FlaskConicalIcon />
            {adding ? "Adding demo data…" : "Explore with demo data"}
          </Button>
        </div>
      </EmptyHeader>
    </Empty>
  );
}
