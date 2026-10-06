/**
 * Settings → Calendar: Otter Calendar's settings (accounts and Google sign-in, preferences,
 * demo data), vendored as `components/calendar/CalendarSettings`. On an environment without
 * the calendar module it explains why there is nothing to set.
 */
import { CalendarPromptHost } from "../../components/calendar/CalendarPromptHost";
import { CalendarSettings } from "../../components/calendar/CalendarSettings";
import { GoogleConnectDialog } from "../../components/calendar/GoogleConnectDialog";
import { SuiteModuleUnavailable } from "../SuiteModuleUnavailable";
import { suiteHasModule, useSuiteCapabilities } from "../useSuiteCapabilities";
import { useActiveEnvironmentId } from "./upstreamShims/activeEnvironment";

export function CalendarSettingsSection() {
  const capabilities = useSuiteCapabilities();
  const environmentId = useActiveEnvironmentId();
  if (capabilities.status !== "loading" && !suiteHasModule(capabilities, "calendar")) {
    return (
      <SuiteModuleUnavailable
        label="Calendar"
        plainServer={capabilities.status === "unavailable"}
      />
    );
  }
  return (
    <>
      <CalendarSettings />
      <GoogleConnectDialog environmentId={environmentId} />
      <CalendarPromptHost />
    </>
  );
}
