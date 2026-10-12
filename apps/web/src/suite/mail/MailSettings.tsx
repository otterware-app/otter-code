/** Settings → Mail reads the existing core and opens its preferences in the retained frame. */
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import { Button } from "../../components/ui/button";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { SuiteModuleUnavailable } from "../SuiteModuleUnavailable";
import { suiteHasModule, useSuiteCapabilities } from "../useSuiteCapabilities";
import { invokeMailChannel } from "./mailHost";

const Accounts = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    email: Schema.String,
    name: Schema.String,
    provider: Schema.optional(Schema.String),
    signedOut: Schema.optional(Schema.Boolean),
  }),
);
const GoogleStatus = Schema.Struct({
  configured: Schema.Boolean,
  hasBuildClientSecret: Schema.Boolean,
  hasClientSecret: Schema.Boolean,
});
const decodeAccounts = Schema.decodeUnknownSync(Accounts);
const decodeGoogle = Schema.decodeUnknownSync(GoogleStatus);
const PANES = ["general", "accounts", "keybindings", "integrations"] as const;

export function MailSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const capabilities = useSuiteCapabilities();
  const available = suiteHasModule(capabilities, "mail");
  const [status, setStatus] = useState<{
    environmentId: typeof environmentId;
    accounts: typeof Accounts.Type;
    google: typeof GoogleStatus.Type;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!environmentId || !available) return;
    let active = true;
    void Promise.all([
      invokeMailChannel(environmentId, "gmail:listAccounts"),
      invokeMailChannel(environmentId, "otterware:googleStatus"),
    ])
      .then(([accounts, google]) => {
        if (active) {
          setStatus({
            environmentId,
            accounts: decodeAccounts(accounts),
            google: decodeGoogle(google),
          });
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [available, environmentId]);
  if (capabilities.status !== "loading" && !suiteHasModule(capabilities, "mail"))
    return (
      <SuiteModuleUnavailable label="Mail" plainServer={capabilities.status === "unavailable"} />
    );
  const current = status?.environmentId === environmentId ? status : null;
  return (
    <SettingsPageContainer>
      <SettingsSection title="Otter Mail">
        <SettingsRow
          {...searchableSetting("mail-accounts")}
          title="Connected accounts"
          description={
            error ??
            (current
              ? current.accounts.length
                ? `${current.accounts.length} connected mailbox${current.accounts.length === 1 ? "" : "es"}.`
                : "No mailboxes connected."
              : "Reading Mail connections…")
          }
        >
          {current?.accounts.map((account) => (
            <div key={account.id} className="px-4 pb-3 text-sm">
              <span className="font-medium">{account.name || account.email}</span> · {account.email}
              <p className="text-muted-foreground">
                {account.provider === "imap"
                  ? "IMAP connected"
                  : account.provider === "outlook"
                    ? "Microsoft"
                    : `Google: ${account.signedOut ? "Sign in required" : "Signed in"}`}
              </p>
            </div>
          ))}
        </SettingsRow>
        <SettingsRow
          {...searchableSetting("mail-google-sign-in")}
          title="Google sign-in"
          description={
            current
              ? current.google.configured
                ? "Available for connecting Gmail accounts."
                : "Unavailable in this server. You can connect an IMAP mailbox."
              : "Reading Google sign-in configuration…"
          }
        />
        <SettingsRow
          title="Google client secret"
          description={
            current
              ? `Build: ${current.google.hasBuildClientSecret ? "included" : "not included"}. Current server: ${current.google.hasClientSecret ? "configured" : "not configured"}.`
              : "Reading build configuration…"
          }
        />
      </SettingsSection>
      <SettingsSection title="Mail preferences">
        {PANES.map((pane) => (
          <SettingsRow
            key={pane}
            title={pane[0]!.toUpperCase() + pane.slice(1)}
            description={
              pane === "accounts"
                ? "Connect, reconnect and manage mailboxes."
                : `Open Mail’s ${pane} preferences.`
            }
            control={
              <Button
                size="sm"
                variant="outline"
                render={<Link to="/mail" search={{ at: `/settings/${pane}` }} />}
              >
                Open
              </Button>
            }
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
