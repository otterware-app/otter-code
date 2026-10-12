import { DRIVE_CONTENT_HOST, DRIVE_DEFAULT_BASE_URL, isDriveHost } from "@t3tools/contracts/suite";

/** A suite-owned account signs out through its host, without another browser login. */
export function isDriveSuiteSignOutUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      url.origin === DRIVE_DEFAULT_BASE_URL &&
      url.pathname === "/api/auth/browser-sign-out/start"
    );
  } catch {
    return false;
  }
}

/** Drive and Accounts share the guest's session; other links belong in the system browser. */
export function isDriveViewUrl(value: string, baseUrl: string): boolean {
  try {
    const url = new URL(value);
    const base = new URL(baseUrl);
    if (url.username || url.password) return false;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.origin === base.origin))
      return false;
    return (
      url.origin === base.origin ||
      (url.protocol === "https:" &&
        url.port === "" &&
        (isDriveHost(url.hostname) ||
          url.hostname === "accounts.otterware.app" ||
          url.hostname === DRIVE_CONTENT_HOST))
    );
  } catch {
    return false;
  }
}

/** Renderer CSS pixels become native device independent points, including application zoom. */
export function driveViewBounds(
  bounds: { x: number; y: number; width: number; height: number },
  zoom: number,
) {
  if (!Object.values(bounds).every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0)
    return null;
  return {
    x: Math.max(0, Math.round(bounds.x * zoom)),
    y: Math.max(0, Math.round(bounds.y * zoom)),
    width: Math.max(1, Math.round(bounds.width * zoom)),
    height: Math.max(1, Math.round(bounds.height * zoom)),
  };
}
