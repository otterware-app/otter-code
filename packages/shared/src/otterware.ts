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

/**
 * Versions are `<core>-otterware.<yyyymmdd>.<run>`. No Otter Code channel
 * pattern (`-nightly.`, `-preview.`) matches them, and they are only ever
 * attached to draft GitHub releases tagged `otterware-v<version>`, which
 * neither electron-updater nor the runtime installer (`v<version>` tags, drafts
 * skipped) can see.
 */
export const OTTERWARE_RELEASE_TAG_PREFIX = "otterware-v";
const OTTERWARE_VERSION_PATTERN = /^\d+\.\d+\.\d+-otterware\.\d{8}\.\d+$/;

export function isOtterwareVersion(version: string | null | undefined): boolean {
  return (
    version !== null && version !== undefined && OTTERWARE_VERSION_PATTERN.test(version.trim())
  );
}

/** Shown wherever Otter Code would offer an update. */
export const OTTERWARE_UPDATE_NOTICE =
  "Otterware preview: automatic updates are off. Install new builds from the Otterware Release workflow on GitHub Actions.";
export const OTTERWARE_SERVER_UPDATE_NOTICE =
  "This server runs Otterware, which never updates itself to an Otter Code release. Switch it with scripts/otterware/fleet-server.sh.";
