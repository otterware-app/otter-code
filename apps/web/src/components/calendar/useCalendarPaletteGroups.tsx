/** The command palette's calendar entries: navigation, views, actions, and each calendar. */
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CalendarDaysIcon,
  CalendarSearchIcon,
  CalendarIcon,
  EyeIcon,
  EyeOffIcon,
  FlaskConicalIcon,
  LogInIcon,
  PlusIcon,
  Redo2Icon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  Undo2Icon,
} from "lucide-react";
import { useMemo } from "react";

import { toastCommandFailure } from "../../suite/calendar/upstreamShims/commandFailureToast";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { calendarEnvironment, useCalendarDirectory } from "../../state/calendar";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "../../suite/calendar/upstreamShims/commandPaletteLogic";
import { setCalendarVisible } from "./calendarActions";
import { type CalendarCommand, runCalendarCommand } from "./calendarCommands";
import { useCalendarUi } from "./calendarUiStore";
import { CALENDAR_VIEWS, VIEW_COMMANDS, viewLabel } from "./calendarView.logic";

export function useCalendarPaletteGroups(
  environmentId: EnvironmentId | null,
): ReadonlyArray<CommandPaletteGroup> {
  const navigate = useNavigate();
  const { directory } = useCalendarDirectory(environmentId);
  const openGoogleConnect = useCalendarUi((state) => state.openGoogleConnect);
  return useMemo(() => {
    const disabled = environmentId === null;
    const hasAccounts = (directory?.accounts.length ?? 0) > 0;
    const run = (command: CalendarCommand) => () =>
      runCalendarCommand(command, () => void navigate({ to: "/calendar" }));
    const action = (
      item: Omit<CommandPaletteActionItem, "kind" | "disabled"> & { disabled?: boolean },
    ): CommandPaletteActionItem => ({
      kind: "action",
      ...item,
      disabled: disabled || item.disabled === true,
    });
    const icon = (Icon: typeof CalendarIcon) => <Icon className={ITEM_ICON_CLASS} />;
    const actions: CommandPaletteActionItem[] = [
      action({
        value: "calendar:today",
        searchTerms: ["Today", "go to today calendar"],
        title: "Today",
        icon: icon(CalendarDaysIcon),
        shortcutCommand: "calendar.today",
        run: run("calendar.today"),
      }),
      action({
        value: "calendar:new-event",
        searchTerms: ["New event", "create add meeting"],
        title: "New event",
        icon: icon(PlusIcon),
        shortcutCommand: "calendar.create",
        disabled: !hasAccounts,
        run: run("calendar.create"),
      }),
      action({
        value: "calendar:search",
        searchTerms: ["Search events", "find"],
        title: "Search events",
        icon: icon(SearchIcon),
        shortcutCommand: "calendar.search",
        disabled: !hasAccounts,
        run: run("calendar.search"),
      }),
      action({
        value: "calendar:go-to-date",
        searchTerms: ["Go to date", "jump day"],
        title: "Go to date",
        icon: icon(CalendarSearchIcon),
        shortcutCommand: "calendar.goToDate",
        run: run("calendar.goToDate"),
      }),
      action({
        value: "calendar:next",
        searchTerms: ["Next period", "forward week month"],
        title: "Next period",
        icon: icon(ArrowRightIcon),
        shortcutCommand: "calendar.next",
        run: run("calendar.next"),
      }),
      action({
        value: "calendar:previous",
        searchTerms: ["Previous period", "back week month"],
        title: "Previous period",
        icon: icon(ArrowLeftIcon),
        shortcutCommand: "calendar.previous",
        run: run("calendar.previous"),
      }),
      ...CALENDAR_VIEWS.map((view) => {
        const label = viewLabel(view, directory?.preferences.customDays ?? 4);
        return action({
          value: `calendar:view:${view}`,
          searchTerms: [`${label} view`, "switch calendar view"],
          title: `${label} view`,
          icon: icon(CalendarIcon),
          shortcutCommand: VIEW_COMMANDS[view],
          run: run(VIEW_COMMANDS[view]),
        });
      }),
      action({
        value: "calendar:undo",
        searchTerms: ["Undo", "revert last change"],
        title: "Undo last change",
        icon: icon(Undo2Icon),
        shortcutCommand: "calendar.undo",
        run: run("calendar.undo"),
      }),
      action({
        value: "calendar:redo",
        searchTerms: ["Redo"],
        title: "Redo",
        icon: icon(Redo2Icon),
        shortcutCommand: "calendar.redo",
        run: run("calendar.redo"),
      }),
      action({
        value: "calendar:add-google",
        searchTerms: ["Add Google account", "connect sign in"],
        title: "Add Google account",
        icon: icon(LogInIcon),
        disabled: directory?.google.configured !== true,
        run: () => openGoogleConnect(),
      }),
      action({
        value: "calendar:add-demo",
        searchTerms: ["Add demo data", "sample example"],
        title: "Add demo data",
        icon: icon(FlaskConicalIcon),
        run: async () => {
          if (environmentId === null) return;
          const result = await runAtomCommand(
            appAtomRegistry,
            calendarEnvironment.addDemo,
            { environmentId, input: { size: "standard" } },
            { reportFailure: false },
          );
          toastCommandFailure("Could not add demo data", result);
        },
      }),
      action({
        value: "calendar:sync",
        searchTerms: ["Sync now", "refresh calendars"],
        title: "Sync now",
        icon: icon(RefreshCwIcon),
        disabled: !hasAccounts,
        run: async () => {
          if (environmentId === null) return;
          const result = await runAtomCommand(
            appAtomRegistry,
            calendarEnvironment.sync,
            { environmentId, input: {} },
            { reportFailure: false },
          );
          toastCommandFailure("Could not sync", result);
        },
      }),
      action({
        value: "calendar:settings",
        searchTerms: ["Calendar settings", "preferences accounts"],
        title: "Calendar settings",
        icon: icon(SettingsIcon),
        run: () => navigate({ to: "/settings/calendar" }),
      }),
    ];
    const calendarItems: CommandPaletteActionItem[] =
      environmentId === null || directory === null
        ? []
        : directory.calendars.map((calendar) => {
            const account = directory.accounts.find(
              (candidate) => candidate.accountId === calendar.accountId,
            );
            const verb = calendar.visible ? "Hide" : "Show";
            return action({
              value: `calendar:toggle:${calendar.calendarId}`,
              searchTerms: [`${verb} ${calendar.name}`, calendar.name, account?.email ?? ""],
              title: `${verb} ${calendar.name}`,
              ...(account ? { description: account.email } : {}),
              icon: calendar.visible ? icon(EyeOffIcon) : icon(EyeIcon),
              titleLeadingContent: (
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: calendar.color }}
                />
              ),
              run: () => void setCalendarVisible(environmentId, calendar, !calendar.visible),
            });
          });
    return [
      { value: "calendar", label: "Calendar", items: actions },
      { value: "calendars", label: "Calendars", items: calendarItems, searchOnly: true },
    ];
  }, [directory, environmentId, navigate, openGoogleConnect]);
}
