/** Settings → Drive: this server's sign-in to Otter Drive. */
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import { DrivePendingCode, useDriveConnectionActions } from "./DriveConnect";

export function DriveSettingsPanel() {
  const { environmentId, status, busy, sharedAccount, connect, disconnect } =
    useDriveConnectionActions();
  const description =
    environmentId === null
      ? "This environment is not an Otterware server with Drive."
      : status === null
        ? "Reading the connection…"
        : status.status === "connected"
          ? `Signed in${status.account ? ` as ${status.account.name}` : ""} at ${new URL(status.baseUrl).host}. Agents in every thread can read and publish your documents.`
          : status.status === "pending"
            ? "Waiting for you to approve this server in Otter Drive."
            : status.status === "error"
              ? status.message
              : `Sign this server in to ${new URL(status.baseUrl).host} to browse documents, link them to threads and let agents use them.`;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Otter Drive">
        <SettingsRow
          {...searchableSetting("drive-connection")}
          title="Drive connection"
          description={description}
          control={
            environmentId === null || status === null ? null : status.status === "connected" ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void disconnect()}>
                {sharedAccount ? "Sign out of Otter" : "Disconnect"}
              </Button>
            ) : status.status === "pending" ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disconnect()}>
                Cancel
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => void connect()}>
                {busy ? <Spinner /> : null}
                Connect
              </Button>
            )
          }
        >
          {status?.status === "pending" ? (
            <div className="px-3 pb-4 sm:px-4">
              <DrivePendingCode status={status} />
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
