/**
 * `../AppPage` for the vendored calendar (a manifest import remap). Otter Calendar's page frame
 * owns the window header; in Otterware the page sits inside `SuiteModuleLayout`, so the title
 * and toolbar go into the layout's header through `CalendarHeaderSlot`.
 */
import { Link } from "@tanstack/react-router";
import { LinkIcon } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

import { Button } from "../../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../../components/ui/empty";

/** The element in the module header the calendar toolbar renders into. */
export const CalendarHeaderSlot = createContext<HTMLElement | null>(null);

export function AppPage({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const slot = useContext(CalendarHeaderSlot);
  return (
    <>
      {slot === null
        ? null
        : createPortal(
            <>
              <span className="min-w-0 truncate text-sm text-muted-foreground">{title}</span>
              {actions}
            </>,
            slot,
          )}
      <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
    </>
  );
}

/** Shown in place of the calendar while no environment is connected. */
export function NoEnvironmentState() {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <LinkIcon className="mx-auto mb-3 size-6 text-muted-foreground" aria-hidden />
        <EmptyTitle>No environment connected</EmptyTitle>
        <EmptyDescription>
          Calendar runs on your Otterware environment. Connect one to see your calendars.
        </EmptyDescription>
        <div className="mt-5 flex justify-center">
          <Button render={<Link to="/settings/connections" />} size="sm">
            Open Connections
          </Button>
        </div>
      </EmptyHeader>
    </Empty>
  );
}
