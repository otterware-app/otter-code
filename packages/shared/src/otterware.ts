/**
 * Otterware identity: the one place the desktop product name, IDs and URL
 * schemes live, so the Otterware branch rebases onto Otter Code with only
 * import-site edits. Otterware is Otter Code plus the Mail, Calendar and Drive
 * modules. Only the desktop app is renamed: the server, CLI (`otter-code`),
 * service (`otter-code.service`) and data home (`~/.otter-code`) stay Otter
 * Code's, so either product's server can run on the same data.
 *
 * Plain constants with no imports: `apps/desktop/scripts/electron-launcher.mjs`
 * loads this file directly with Node's type stripping.
 */

export const OTTERWARE_PRODUCT_NAME = "Otterware";
export const OTTERWARE_DEV_PRODUCT_NAME = "Otterware (Dev)";

/** macOS bundle ID, Windows AppUserModelID, and Linux desktop-entry stem. */
export const OTTERWARE_APP_ID = "dev.otterware.suite";
export const OTTERWARE_DEV_APP_ID = "dev.otterware.suite.dev";

/** Deep links and the custom protocol the packaged renderer is served from. */
export const OTTERWARE_URL_SCHEME = "otterware";
export const OTTERWARE_DEV_URL_SCHEME = "otterware-dev";

/**
 * Linux executable, package and WM class, and the Electron userData folder
 * name. A userData folder of its own also gives Otterware its own Chromium
 * profile and single-instance lock, so it runs beside Otter Code.
 */
export const OTTERWARE_SLUG = "otterware";
export const OTTERWARE_DEV_SLUG = "otterware-dev";

/** Installer file names: `Otterware-<version>-<arch>.<ext>`. */
export const OTTERWARE_ARTIFACT_NAME = "Otterware-${version}-${arch}.${ext}";

/** Suite versions and feeds never overlap Otter Code's release repository. */
export const OTTERWARE_RELEASE_TAG_PREFIX = "otterware-v";
const OTTERWARE_VERSION_PATTERN = /^\d+\.\d+\.\d+-otterware\.\d{8}\.\d+$/;

export function isOtterwareVersion(version: string | null | undefined): boolean {
  return (
    version !== null && version !== undefined && OTTERWARE_VERSION_PATTERN.test(version.trim())
  );
}

/** Shown wherever Otter Code would offer an update. */
export const OTTERWARE_UPDATE_NOTICE =
  "This Otterware build has no update channel. Install a channel build to enable automatic updates.";
export const OTTERWARE_SERVER_UPDATE_NOTICE =
  "This server runs Otterware, which never updates itself to an Otter Code release. Switch it with scripts/otterware/fleet-server.sh.";

export const OTTERWARE_RELEASE_REPOSITORY = "otterware-app/otterware-releases";

export function sanitizeOtterwareChannel(branch: string): string {
  const channel = branch
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!channel || channel.length > 80)
    throw new Error("Otterware channel must contain 1-80 URL-safe characters");
  return channel;
}

/** Legacy tags follow otterware; explicit tags carry a channel before the -- separator. */
export function resolveOtterwareBuildChannel(refName: string, dispatchBranch?: string): string {
  if (dispatchBranch?.trim()) return sanitizeOtterwareChannel(dispatchBranch);
  const explicit = /^otterware-build-channel-(.+)--(.+)$/.exec(refName);
  if (explicit) return sanitizeOtterwareChannel(explicit[1]!);
  if (refName.startsWith("otterware-build-channel-"))
    throw new Error("Use otterware-build-channel-<channel>--<build-id>");
  return refName.startsWith("otterware-build-") ? "otterware" : sanitizeOtterwareChannel(refName);
}

export function resolveOtterwarePublishConfig(version: string, channel?: string) {
  if (!isOtterwareVersion(version) || !channel?.trim()) return undefined;
  return {
    provider: "generic" as const,
    url: `https://github.com/${OTTERWARE_RELEASE_REPOSITORY}/releases/download/channel-${sanitizeOtterwareChannel(channel)}/`,
    // Each branch has its own URL, with conventional latest-mac/latest-linux files.
    channel: "latest",
    useMultipleRangeRequest: false,
  };
}

/** Accept only an exact suite feed baked by packaging, never a repository/env override. */
export function isOtterwareUpdateFeed(config: Readonly<Record<string, string>>): boolean {
  if (config.provider !== "generic" || config.channel !== "latest") return false;
  const prefix = `https://github.com/${OTTERWARE_RELEASE_REPOSITORY}/releases/download/channel-`;
  if (!config.url?.startsWith(prefix)) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(config.url.slice(prefix.length));
}
