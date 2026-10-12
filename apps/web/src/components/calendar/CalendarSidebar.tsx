/**
 * The calendar's part of the main sidebar (Notion Calendar style): a mini month, then every
 * account with its calendars, each with its color, a visibility toggle and a color menu.
 * Signed-out and failing accounts say so here, with a way back in.
 */
import type {
  Calendar,
  CalendarAccount,
  CalendarDirectory,
  EnvironmentId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FlaskConicalIcon,
  LogInIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type CSSProperties, useMemo, useState } from "react";

import { toastCommandFailure } from "../../suite/calendar/upstreamShims/commandFailureToast";
import { calendarEnvironment } from "../../state/calendar";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { setCalendarColor, setCalendarVisible } from "./calendarActions";
import { CALENDAR_COLORS } from "./calendarColors";
import { runCalendarCommand } from "./calendarCommands";
import { accountNeedsAttention, accountStatusLabel } from "./calendarFormat";
import { useCalendarUi } from "./calendarUiStore";
import { calendarRange } from "./calendarView.logic";
import { MiniMonth } from "./MiniMonth";
import { useCalendarContext, useCalendarLocation } from "./useCalendarContext";

function AccountAvatar({ account }: { account: CalendarAccount }) {
  if (account.avatarUrl) {
    return (
      <img
        src={account.avatarUrl}
        alt=""
        referrerPolicy="no-referrer"
        className="size-4 shrink-0 rounded-full"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-medium text-muted-foreground uppercase"
    >
      {(account.displayName || account.email).slice(0, 1)}
    </span>
  );
}

/** A calendar's color as a checkbox: filled when shown, outlined when hidden. */
function VisibilitySwatch({ calendar }: { calendar: Calendar }) {
  const style = {
    borderColor: calendar.color,
    backgroundColor: calendar.visible ? calendar.color : "transparent",
  } satisfies CSSProperties;
  return (
    <span
      aria-hidden
      className="flex size-3.5 shrink-0 items-center justify-center rounded-sm border-2"
      style={style}
    >
      {calendar.visible ? <CheckIcon className="size-2.5 text-white" strokeWidth={3.5} /> : null}
    </span>
  );
}

function CalendarRow({
  environmentId,
  calendar,
  siblings,
}: {
  environmentId: EnvironmentId;
  calendar: Calendar;
  siblings: ReadonlyArray<Calendar>;
}) {
  return (
    <SidebarMenuItem className="group/calendar-row" data-calendar-row={calendar.calendarId}>
      <SidebarMenuButton
        role="checkbox"
        aria-checked={calendar.visible}
        data-calendar-visibility=""
        onClick={() => void setCalendarVisible(environmentId, calendar, !calendar.visible)}
      >
        <VisibilitySwatch calendar={calendar} />
        <span className="min-w-0 flex-1 truncate">{calendar.name}</span>
      </SidebarMenuButton>
      <div className="absolute end-1 top-1 opacity-0 group-hover/calendar-row:opacity-100 has-focus-visible:opacity-100 has-data-popup-open:opacity-100">
        <Popover>
          <PopoverTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label={`Options for ${calendar.name}`}
              />
            }
          >
            <EllipsisIcon />
          </PopoverTrigger>
          <PopoverPopup side="right" align="start" padding="compact" width="sm">
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-muted-foreground">Color</span>
              <div className="grid grid-cols-6 gap-1.5" role="radiogroup" aria-label="Color">
                {CALENDAR_COLORS.map((color) => {
                  const checked = calendar.color.toLowerCase() === color.hex;
                  return (
                    <button
                      key={color.hex}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      aria-label={color.name}
                      className="flex size-6 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-popover"
                      style={{ backgroundColor: color.hex }}
                      onClick={() => void setCalendarColor(environmentId, calendar, color.hex)}
                    >
                      {checked ? (
                        <CheckIcon className="size-3.5 text-white" strokeWidth={3} />
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  for (const other of siblings) {
                    const visible = other.calendarId === calendar.calendarId;
                    if (other.visible !== visible) {
                      void setCalendarVisible(environmentId, other, visible);
                    }
                  }
                }}
              >
                Show only this calendar
              </Button>
            </div>
          </PopoverPopup>
        </Popover>
      </div>
    </SidebarMenuItem>
  );
}

function AccountSection({
  environmentId,
  account,
  calendars,
  allCalendars,
}: {
  environmentId: EnvironmentId;
  account: CalendarAccount;
  calendars: ReadonlyArray<Calendar>;
  allCalendars: ReadonlyArray<Calendar>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const sync = useAtomCommand(calendarEnvironment.sync, { reportFailure: false });
  const openGoogleConnect = useCalendarUi((state) => state.openGoogleConnect);
  const navigate = useNavigate();
  const attention = accountNeedsAttention(account);
  return (
    <li className="flex flex-col" data-calendar-account={account.accountId}>
      <div className="group/account flex h-7 items-center gap-1.5 ps-2 pe-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm text-left text-xs text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <AccountAvatar account={account} />
          <span className="min-w-0 truncate font-medium">{account.email}</span>
          {collapsed ? (
            <ChevronRightIcon className="size-3 shrink-0 opacity-60" />
          ) : (
            <ChevronDownIcon className="size-3 shrink-0 opacity-0 group-hover/account:opacity-60" />
          )}
        </button>
        {attention ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label={account.status === "signed_out" ? "Reconnect" : "Sync failed, retry"}
                  onClick={() => {
                    if (account.status === "signed_out") openGoogleConnect(account.email);
                    else
                      void sync({ environmentId, input: { accountId: account.accountId } }).then(
                        (result) => toastCommandFailure("Could not sync", result),
                      );
                  }}
                />
              }
            >
              <TriangleAlertIcon className="text-warning" />
            </TooltipTrigger>
            <TooltipPopup side="right">{accountStatusLabel(account)}</TooltipPopup>
          </Tooltip>
        ) : null}
        <span className="flex opacity-0 group-hover/account:opacity-100 has-focus-visible:opacity-100 has-data-popup-open:opacity-100">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label={`Options for ${account.email}`}
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="start" side="right">
              <MenuGroupLabel>{accountStatusLabel(account)}</MenuGroupLabel>
              <MenuItem
                onClick={() =>
                  void sync({ environmentId, input: { accountId: account.accountId } }).then(
                    (result) => toastCommandFailure("Could not sync", result),
                  )
                }
              >
                <RefreshCwIcon />
                Sync now
              </MenuItem>
              {account.provider === "google" ? (
                <MenuItem onClick={() => openGoogleConnect(account.email)}>
                  <LogInIcon />
                  Reconnect
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem onClick={() => void navigate({ to: "/settings/calendar" })}>
                <SettingsIcon />
                Account settings
              </MenuItem>
            </MenuPopup>
          </Menu>
        </span>
      </div>
      {account.status === "signed_out" && !collapsed ? (
        <div className="px-2 pb-1">
          <Button
            size="xs"
            variant="warning-outline"
            onClick={() => openGoogleConnect(account.email)}
          >
            <LogInIcon />
            Reconnect
          </Button>
        </div>
      ) : null}
      {collapsed ? null : (
        <SidebarMenu>
          {calendars.map((calendar) => (
            <CalendarRow
              key={calendar.calendarId}
              environmentId={environmentId}
              calendar={calendar}
              siblings={allCalendars}
            />
          ))}
        </SidebarMenu>
      )}
    </li>
  );
}

function groupCalendars(directory: CalendarDirectory) {
  const accounts = [...directory.accounts].sort((a, b) => a.position - b.position);
  return accounts.map((account) => ({
    account,
    calendars: directory.calendars
      .filter((calendar) => calendar.accountId === account.accountId)
      .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name)),
  }));
}

/** Mini month plus accounts and calendars; shown in the main sidebar on the calendar page. */
export function CalendarSidebar() {
  const { environmentId, directory, preferences, today } = useCalendarContext();
  const location = useCalendarLocation(today);
  const navigate = useNavigate();
  const openGoogleConnect = useCalendarUi((state) => state.openGoogleConnect);
  const addDemo = useAtomCommand(calendarEnvironment.addDemo, { reportFailure: false });
  const range = useMemo(
    () => calendarRange(location.view, location.anchor, preferences),
    [location.view, location.anchor, preferences],
  );
  const groups = useMemo(() => (directory === null ? [] : groupCalendars(directory)), [directory]);
  if (environmentId === null) return null;
  const hasDemo = directory?.accounts.some((account) => account.provider === "demo") ?? false;
  return (
    <>
      <SidebarGroup>
        <div className="px-1">
          <MiniMonth
            anchor={location.anchor}
            today={today}
            weekStartsOn={preferences.weekStartsOn}
            range={range}
            label="Go to date"
            onPick={(day) =>
              runCalendarCommand({ goTo: day }, () => void navigate({ to: "/calendar" }))
            }
          />
        </div>
      </SidebarGroup>
      {directory !== null && directory.accounts.length > 0 ? (
        <SidebarGroup aria-label="Calendars">
          <ul className="flex flex-col gap-2" data-calendar-accounts="">
            {groups.map((group) => (
              <AccountSection
                key={group.account.accountId}
                environmentId={environmentId}
                account={group.account}
                calendars={group.calendars}
                allCalendars={directory.calendars}
              />
            ))}
          </ul>
          <SidebarMenu className="mt-2">
            <SidebarMenuItem>
              <SidebarMenuButton size="sm" onClick={() => openGoogleConnect()}>
                <PlusIcon />
                <span>Add Google account</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {hasDemo ? null : (
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  onClick={() =>
                    void addDemo({ environmentId, input: { size: "standard" } }).then((result) =>
                      toastCommandFailure("Could not add demo data", result),
                    )
                  }
                >
                  <FlaskConicalIcon />
                  <span>Add demo data</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroup>
      ) : null}
    </>
  );
}
