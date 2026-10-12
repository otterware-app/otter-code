/**
 * The calendar's controls in the page header, Notion Calendar style: sync state, search, Today,
 * previous/next, and the view switcher. Fixed widths, so paging never shifts them.
 */
import { useAtomValue } from "@effect/atom-react";
import type { CalendarAccount, EnvironmentId, KeybindingCommand } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloudAlertIcon,
  CloudCheckIcon,
  CloudIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { toastCommandFailure } from "../../suite/calendar/upstreamShims/commandFailureToast";
import { calendarEnvironment } from "../../state/calendar";
import { primaryServerKeybindingsAtom } from "../../suite/calendar/upstreamShims/serverState";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { CalendarCommand } from "./calendarCommands";
import { accountNeedsAttention, accountStatusLabel, syncedLabel } from "./calendarFormat";
import { useCalendarUi } from "./calendarUiStore";
import {
  CALENDAR_VIEWS,
  type CalendarViewKind,
  VIEW_COMMANDS,
  isCalendarView,
  viewLabel,
} from "./calendarView.logic";

function HintedButton({
  label,
  command,
  hint,
  children,
  ...props
}: {
  label: string;
  command?: KeybindingCommand;
  hint?: string;
  children: ReactNode;
} & Omit<ComponentProps<typeof Button>, "children">) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, command ?? null);
  return (
    <Tooltip>
      <TooltipTrigger render={<Button aria-label={label} {...props} />}>{children}</TooltipTrigger>
      <TooltipPopup side="bottom">
        {hint ?? label}
        {shortcut ? ` (${shortcut})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Sync state of every account; errors and signed-out accounts surface here and in the sidebar. */
export function CalendarSyncStatus({
  environmentId,
  accounts,
}: {
  environmentId: EnvironmentId;
  accounts: ReadonlyArray<CalendarAccount>;
}) {
  const sync = useAtomCommand(calendarEnvironment.sync, { reportFailure: false });
  const openGoogleConnect = useCalendarUi((state) => state.openGoogleConnect);
  if (accounts.length === 0) return null;
  const troubled = accounts.filter(accountNeedsAttention);
  const syncing = accounts.some((account) => account.status === "syncing");
  const lastSynced = Math.min(
    ...accounts.map((account) => account.lastSyncedAt ?? Number.POSITIVE_INFINITY),
  );
  const summary =
    troubled.length > 0
      ? `${troubled.length === 1 ? "An account needs" : `${troubled.length} accounts need`} attention`
      : syncing
        ? "Syncing…"
        : syncedLabel(Number.isFinite(lastSynced) ? lastSynced : undefined);
  const Icon = troubled.length > 0 ? CloudAlertIcon : syncing ? CloudIcon : CloudCheckIcon;
  const syncNow = async (accountId?: CalendarAccount["accountId"]) => {
    const result = await sync({
      environmentId,
      input: accountId === undefined ? {} : { accountId },
    });
    toastCommandFailure("Could not sync", result);
  };
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant={troubled.length > 0 ? "warning-outline" : "ghost-muted"}
                  aria-label={`Sync status: ${summary}`}
                  data-calendar-sync={
                    troubled.length > 0 ? "attention" : syncing ? "syncing" : "ok"
                  }
                />
              }
            />
          }
        >
          <Icon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{summary}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="w-72">
        <MenuGroup>
          <MenuGroupLabel>Accounts</MenuGroupLabel>
          {accounts.map((account) => (
            <MenuItem
              key={account.accountId}
              onClick={() => {
                if (account.status === "signed_out") openGoogleConnect(account.email);
                else void syncNow(account.accountId);
              }}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{account.email}</span>
                <span
                  className={
                    accountNeedsAttention(account)
                      ? "truncate text-xs text-warning-foreground"
                      : "truncate text-xs text-muted-foreground"
                  }
                >
                  {accountStatusLabel(account)}
                </span>
              </span>
            </MenuItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={() => void syncNow()}>
          <RefreshCwIcon />
          Sync now
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function CalendarToolbar({
  view,
  customDays,
  todayLabel,
  onCommand,
  status,
}: {
  view: CalendarViewKind;
  customDays: number;
  /** "Wednesday, September 30", for the Today button's tooltip. */
  todayLabel: string;
  onCommand: (command: CalendarCommand) => void;
  status: ReactNode;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  return (
    <div className="flex items-center gap-1" data-calendar-toolbar="">
      {status}
      <HintedButton
        label="Search events"
        command="calendar.search"
        size="icon-sm"
        variant="ghost-muted"
        onClick={() => onCommand("calendar.search")}
      >
        <SearchIcon />
      </HintedButton>
      <HintedButton
        label="Today"
        hint={todayLabel}
        command="calendar.today"
        size="sm"
        variant="outline"
        onClick={() => onCommand("calendar.today")}
      >
        Today
      </HintedButton>
      <div className="flex items-center">
        <HintedButton
          label="Previous period"
          hint="Previous"
          command="calendar.previous"
          size="icon-sm"
          variant="ghost"
          onClick={() => onCommand("calendar.previous")}
        >
          <ChevronLeftIcon />
        </HintedButton>
        <HintedButton
          label="Next period"
          hint="Next"
          command="calendar.next"
          size="icon-sm"
          variant="ghost"
          onClick={() => onCommand("calendar.next")}
        >
          <ChevronRightIcon />
        </HintedButton>
      </div>
      <ToggleGroup
        aria-label="View"
        variant="segmented"
        className="ms-1 max-xl:hidden"
        value={[view]}
        onValueChange={(next) => {
          const picked = next[0];
          if (isCalendarView(picked)) onCommand(VIEW_COMMANDS[picked]);
        }}
      >
        {CALENDAR_VIEWS.map((option) => {
          const shortcut = shortcutLabelForCommand(keybindings, VIEW_COMMANDS[option]);
          return (
            <Tooltip key={option}>
              <TooltipTrigger render={<Toggle value={option} data-view={option} />}>
                {viewLabel(option, customDays)}
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {viewLabel(option, customDays)} view{shortcut ? ` (${shortcut})` : ""}
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </ToggleGroup>
      <Menu>
        <MenuTrigger
          render={
            <Button size="sm" variant="outline" className="ms-1 xl:hidden" aria-label="View" />
          }
        >
          {viewLabel(view, customDays)}
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuRadioGroup
            value={view}
            onValueChange={(next) => {
              if (isCalendarView(next)) onCommand(VIEW_COMMANDS[next]);
            }}
          >
            {CALENDAR_VIEWS.map((option) => {
              const shortcut = shortcutLabelForCommand(keybindings, VIEW_COMMANDS[option]);
              return (
                <MenuRadioItem key={option} value={option} data-view={option} closeOnClick>
                  {viewLabel(option, customDays)}
                  {shortcut ? <MenuShortcut>{shortcut}</MenuShortcut> : null}
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </div>
  );
}
