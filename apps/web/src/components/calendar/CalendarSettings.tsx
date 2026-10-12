/**
 * Settings → Calendar: accounts (sync, reconnect, remove), the environment's Google OAuth
 * client, demo data, and calendar preferences. Preferences live on the environment, so every
 * device shows the same week start, zone and working hours.
 */
import {
  type CalendarAccount,
  type CalendarDirectory,
  type CalendarPreferences,
  type CalendarPreferencesPatch,
  CalendarId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { formatMinutes } from "@t3tools/client-runtime/calendar/format";
import { systemTimeZone } from "@t3tools/shared/calendar/time";
import { BRAND } from "@t3tools/shared/brand";
import { ExternalLinkIcon, LogInIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { toastCommandFailure } from "../../suite/calendar/upstreamShims/commandFailureToast";
import { useActiveEnvironmentId } from "../../suite/calendar/upstreamShims/activeEnvironment";
import { calendarEnvironment, useCalendarDirectory } from "../../state/calendar";
import { useAtomCommand } from "../../state/use-atom-command";
import { NoEnvironmentState } from "../../suite/calendar/upstreamShims/AppPage";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { accountStatusLabel } from "./calendarFormat";
import { useCalendarUi } from "./calendarUiStore";
import { TimeField, TimeZoneField } from "./EventEditorFields";

const GOOGLE_CREDENTIALS_URL = "https://console.cloud.google.com/apis/credentials";
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const EVENT_LENGTHS = [15, 30, 45, 60, 90, 120];
const CUSTOM_DAYS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 14];

function withPatch(
  preferences: CalendarPreferences,
  patch: CalendarPreferencesPatch,
): CalendarPreferences {
  const next: Record<string, unknown> = { ...preferences };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value;
  }
  return next as CalendarPreferences;
}

function lengthLabel(minutes: number): string {
  return minutes < 60 ? `${minutes} minutes` : minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
}

function AccountRow({
  environmentId,
  account,
}: {
  environmentId: EnvironmentId;
  account: CalendarAccount;
}) {
  const sync = useAtomCommand(calendarEnvironment.sync, { reportFailure: false });
  const removeAccount = useAtomCommand(calendarEnvironment.removeAccount, {
    reportFailure: false,
  });
  const openGoogleConnect = useCalendarUi((state) => state.openGoogleConnect);
  return (
    <SettingsRow
      data-calendar-account-row={account.accountId}
      title={account.email}
      description={
        account.provider === "demo"
          ? "Demo account"
          : account.displayName && account.displayName !== account.email
            ? account.displayName
            : "Google account"
      }
      status={
        <span
          className={
            account.status === "error" || account.status === "signed_out"
              ? "text-warning-foreground"
              : undefined
          }
        >
          {accountStatusLabel(account)}
        </span>
      }
      control={
        <>
          {account.provider === "google" ? (
            <Button
              size="xs"
              variant={account.status === "signed_out" ? "warning-outline" : "outline"}
              onClick={() => openGoogleConnect(account.email)}
            >
              <LogInIcon />
              Reconnect
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            onClick={async () => {
              const result = await sync({ environmentId, input: { accountId: account.accountId } });
              toastCommandFailure("Could not sync", result);
            }}
          >
            <RefreshCwIcon />
            Sync now
          </Button>
          <Button
            size="icon-xs"
            variant="ghost-destructive"
            aria-label={`Remove ${account.email}`}
            onClick={async () => {
              const confirmed = await ensureLocalApi().dialogs.confirm(
                `Remove ${account.email}? Its calendars leave ${BRAND.displayName}; nothing changes in Google.`,
                { variant: "destructive" },
              );
              if (!confirmed) return;
              const result = await removeAccount({
                environmentId,
                input: { accountId: account.accountId },
              });
              toastCommandFailure("Could not remove the account", result);
            }}
          >
            <Trash2Icon />
          </Button>
        </>
      }
    />
  );
}

function GoogleClientSection({
  environmentId,
  directory,
}: {
  environmentId: EnvironmentId;
  directory: CalendarDirectory;
}) {
  const setClient = useAtomCommand(calendarEnvironment.googleSetClient, { reportFailure: false });
  const clearClient = useAtomCommand(calendarEnvironment.googleClearClient, {
    reportFailure: false,
  });
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const { google } = directory;
  const sourceLabel =
    google.source === "settings"
      ? "Set here"
      : google.source === "environment"
        ? "From the server's environment variables"
        : google.source === "build"
          ? `Built into ${BRAND.displayName}`
          : null;
  const validId = clientId.trim().endsWith(".apps.googleusercontent.com");
  return (
    <SettingsSection title="Google sign-in">
      <SettingsRow
        title="OAuth client"
        description={
          google.configured
            ? `${sourceLabel ?? "Configured"}: ${google.clientId ?? ""}`
            : "Not set up. Google accounts can't be connected until a client is added."
        }
        control={
          google.source === "settings" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const confirmed = await ensureLocalApi().dialogs.confirm(
                  "Remove the Google OAuth client? Connected accounts stop syncing until one is added again.",
                  { variant: "destructive" },
                );
                if (!confirmed) return;
                const result = await clearClient({ environmentId, input: {} });
                toastCommandFailure("Could not remove the client", result);
              }}
            >
              Remove
            </Button>
          ) : null
        }
      />
      <SettingsRow
        title={google.configured ? "Use another client" : "Add a client"}
        description={
          <>
            In Google Cloud, enable the Google Calendar API, then create an OAuth client of type
            "Desktop app" and paste its ID and secret here. Sign-in returns to http://127.0.0.1 on
            this environment's machine, which Desktop clients allow.{" "}
            <a
              href={GOOGLE_CREDENTIALS_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-foreground underline underline-offset-2"
            >
              Open Google Cloud credentials
              <ExternalLinkIcon className="size-3" aria-hidden />
            </a>
          </>
        }
      >
        <form
          className="flex flex-col gap-2 pb-3 sm:flex-row sm:items-center"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!validId || !clientSecret.trim()) return;
            setSaving(true);
            const result = await setClient({
              environmentId,
              input: { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
            });
            setSaving(false);
            if (!toastCommandFailure("Could not save the client", result)) {
              setClientId("");
              setClientSecret("");
            }
          }}
        >
          <Input
            size="sm"
            aria-label="Client ID"
            placeholder="Client ID (….apps.googleusercontent.com)"
            autoComplete="off"
            spellCheck={false}
            value={clientId}
            aria-invalid={clientId.trim().length > 0 && !validId ? true : undefined}
            onChange={(event) => setClientId(event.target.value)}
          />
          <Input
            size="sm"
            type="password"
            aria-label="Client secret"
            placeholder="Client secret"
            autoComplete="off"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={saving || !validId || !clientSecret.trim()}>
            Save
          </Button>
        </form>
      </SettingsRow>
    </SettingsSection>
  );
}

function DemoSection({
  environmentId,
  directory,
}: {
  environmentId: EnvironmentId;
  directory: CalendarDirectory;
}) {
  const addDemo = useAtomCommand(calendarEnvironment.addDemo, { reportFailure: false });
  const removeAccount = useAtomCommand(calendarEnvironment.removeAccount, {
    reportFailure: false,
  });
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const demoAccounts = directory.accounts.filter((account) => account.provider === "demo");
  const add = async (size: "standard" | "massive") => {
    setBusy(true);
    const parsedSeed = Number.parseInt(seed, 10);
    const result = await addDemo({
      environmentId,
      input: { size, ...(Number.isFinite(parsedSeed) ? { seed: parsedSeed } : {}) },
    });
    setBusy(false);
    toastCommandFailure("Could not add demo data", result);
  };
  return (
    <SettingsSection title="Demo data">
      <SettingsRow
        title="Add demo accounts"
        description="Standard: three accounts with a few months of realistic events. Massive: a large set for trying performance."
        control={
          <>
            <Input
              size="sm"
              type="number"
              aria-label="Seed"
              placeholder="Seed"
              className="w-20"
              value={seed}
              onChange={(event) => setSeed(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void add("standard")}
            >
              Standard
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void add("massive")}>
              Massive
            </Button>
          </>
        }
      />
      {demoAccounts.length > 0 ? (
        <SettingsRow
          title="Remove demo accounts"
          description={`${demoAccounts.length} demo account${demoAccounts.length === 1 ? "" : "s"} and their events.`}
          control={
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={busy}
              onClick={async () => {
                const confirmed = await ensureLocalApi().dialogs.confirm(
                  "Remove every demo account and its events?",
                  { variant: "destructive" },
                );
                if (!confirmed) return;
                setBusy(true);
                for (const account of demoAccounts) {
                  const result = await removeAccount({
                    environmentId,
                    input: { accountId: account.accountId },
                  });
                  if (toastCommandFailure("Could not remove demo data", result)) break;
                }
                setBusy(false);
              }}
            >
              Remove
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

function PreferencesSection({
  environmentId,
  directory,
}: {
  environmentId: EnvironmentId;
  directory: CalendarDirectory;
}) {
  const updatePreferences = useAtomCommand(calendarEnvironment.updatePreferences, {
    reportFailure: false,
  });
  // Changes show at once and stay until the environment's own copy catches up.
  const [pending, setPending] = useState<CalendarPreferencesPatch>({});
  const preferences: CalendarPreferences = withPatch(directory.preferences, pending);
  const deviceZone = systemTimeZone();
  const [now] = useState(() => Date.now());
  const update = async (patch: CalendarPreferencesPatch) => {
    setPending((current) => ({ ...current, ...patch }));
    const result = await updatePreferences({ environmentId, input: patch });
    setPending((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch) as Array<keyof CalendarPreferencesPatch>) {
        if (next[key] === patch[key]) delete next[key];
      }
      return next;
    });
    toastCommandFailure("Could not save the preference", result);
  };
  const writable = directory.calendars.filter(
    (calendar) => calendar.accessRole === "owner" || calendar.accessRole === "writer",
  );
  const defaultCalendar = writable.find(
    (calendar) => calendar.calendarId === preferences.defaultCalendarId,
  );
  const { workingHours } = preferences;
  return (
    <SettingsSection title="Preferences">
      <SettingsRow
        title="Week starts on"
        control={
          <Select
            value={String(preferences.weekStartsOn)}
            onValueChange={(value) => void update({ weekStartsOn: Number(value) })}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Week starts on">
              <SelectValue>{WEEKDAY_NAMES[preferences.weekStartsOn]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {[0, 1, 6].map((day) => (
                <SelectItem key={day} value={String(day)}>
                  {WEEKDAY_NAMES[day]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Time zone"
        description={
          preferences.timeZone === null
            ? `Follows each device. This one is in ${deviceZone.replace(/_/g, " ")}.`
            : "Every device shows the calendar in this zone."
        }
        control={
          <div className="flex w-full items-center gap-2 sm:w-72">
            <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              <Switch
                size="sm"
                checked={preferences.timeZone === null}
                onCheckedChange={(automatic) =>
                  void update({ timeZone: automatic ? null : deviceZone })
                }
              />
              Auto
            </label>
            {preferences.timeZone === null ? null : (
              <TimeZoneField
                label="Calendar time zone"
                zone={preferences.timeZone}
                at={now}
                onChange={(zone) => void update({ timeZone: zone })}
              />
            )}
          </div>
        }
      />
      <SettingsRow
        title="Working hours"
        description="Shaded differently in the day and week views."
        control={
          <div className="flex items-center gap-1.5">
            <div className="w-28">
              <TimeField
                label="Working hours start"
                minutes={workingHours.start}
                hourFormat={preferences.hourFormat}
                onCommit={(start) => void update({ workingHours: { ...workingHours, start } })}
              />
            </div>
            <span className="text-xs text-muted-foreground">to</span>
            <div className="w-28">
              <TimeField
                label="Working hours end"
                minutes={workingHours.end}
                from={workingHours.start}
                hourFormat={preferences.hourFormat}
                onCommit={(end) => void update({ workingHours: { ...workingHours, end } })}
              />
            </div>
          </div>
        }
      >
        <div className="pb-3">
          <ToggleGroup
            aria-label="Working days"
            variant="segmented"
            multiple
            value={workingHours.days.map(String)}
            onValueChange={(days) =>
              void update({ workingHours: { ...workingHours, days: days.map(Number).sort() } })
            }
          >
            {WEEKDAYS.map((day) => (
              <Toggle key={day} value={String(day)} aria-label={WEEKDAY_NAMES[day]}>
                {WEEKDAY_NAMES[day]!.slice(0, 3)}
              </Toggle>
            ))}
          </ToggleGroup>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {formatMinutes(workingHours.start, preferences.hourFormat)} –{" "}
            {formatMinutes(workingHours.end, preferences.hourFormat)} on the selected days.
          </p>
        </div>
      </SettingsRow>
      <SettingsRow
        title="Default event length"
        control={
          <Select
            value={String(preferences.defaultEventMinutes)}
            onValueChange={(value) => void update({ defaultEventMinutes: Number(value) })}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Default event length">
              <SelectValue>{lengthLabel(preferences.defaultEventMinutes)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {EVENT_LENGTHS.map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {lengthLabel(minutes)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Days in the custom view"
        control={
          <Select
            value={String(preferences.customDays)}
            onValueChange={(value) => void update({ customDays: Number(value) })}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-40"
              aria-label="Days in the custom view"
            >
              <SelectValue>{preferences.customDays} days</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {CUSTOM_DAYS.map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {days} days
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Show weekends"
        control={
          <Switch
            checked={preferences.showWeekends}
            onCheckedChange={(showWeekends) => void update({ showWeekends })}
            aria-label="Show weekends"
          />
        }
      />
      <SettingsRow
        title="Show declined events"
        control={
          <Switch
            checked={preferences.showDeclined}
            onCheckedChange={(showDeclined) => void update({ showDeclined })}
            aria-label="Show declined events"
          />
        }
      />
      <SettingsRow
        title="Time format"
        control={
          <Select
            value={preferences.hourFormat}
            onValueChange={(value) => {
              if (value === "locale" || value === "12" || value === "24") {
                void update({ hourFormat: value });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Time format">
              <SelectValue>
                {preferences.hourFormat === "12"
                  ? "12-hour"
                  : preferences.hourFormat === "24"
                    ? "24-hour"
                    : "Language default"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="locale">Language default</SelectItem>
              <SelectItem value="12">12-hour</SelectItem>
              <SelectItem value="24">24-hour</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="New events go to"
        control={
          <Select
            value={preferences.defaultCalendarId ?? "auto"}
            onValueChange={(value) =>
              void update({
                defaultCalendarId: value === "auto" ? null : CalendarId.make(String(value)),
              })
            }
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Default calendar">
              <SelectValue>{defaultCalendar?.name ?? "First account's main calendar"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="auto">First account's main calendar</SelectItem>
              {directory.accounts.map((account) => {
                const calendars = writable.filter(
                  (calendar) => calendar.accountId === account.accountId,
                );
                if (calendars.length === 0) return null;
                return (
                  <SelectGroup key={account.accountId}>
                    <SelectGroupLabel>{account.email}</SelectGroupLabel>
                    {calendars.map((calendar) => (
                      <SelectItem key={calendar.calendarId} value={calendar.calendarId}>
                        {calendar.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                );
              })}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}

export function CalendarSettings() {
  const environmentId = useActiveEnvironmentId();
  const { directory, isLoading } = useCalendarDirectory(environmentId);
  const openGoogleConnect = useCalendarUi((state) => state.openGoogleConnect);
  if (environmentId === null) return <NoEnvironmentState />;
  if (directory === null) {
    return (
      <SettingsPageContainer>
        <p className="px-4 text-sm text-muted-foreground">
          {isLoading ? "Loading calendar settings…" : "Calendar settings are unavailable."}
        </p>
      </SettingsPageContainer>
    );
  }
  const accounts = [...directory.accounts].sort((a, b) => a.position - b.position);
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Accounts"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={!directory.google.configured}
            onClick={() => openGoogleConnect()}
          >
            <PlusIcon />
            Add Google account
          </Button>
        }
      >
        {accounts.length === 0 ? (
          <SettingsRow
            title="No accounts yet"
            description="Connect a Google account, or add demo data below to look around."
          />
        ) : (
          accounts.map((account) => (
            <AccountRow key={account.accountId} environmentId={environmentId} account={account} />
          ))
        )}
      </SettingsSection>
      <PreferencesSection environmentId={environmentId} directory={directory} />
      <GoogleClientSection environmentId={environmentId} directory={directory} />
      <DemoSection environmentId={environmentId} directory={directory} />
    </SettingsPageContainer>
  );
}
