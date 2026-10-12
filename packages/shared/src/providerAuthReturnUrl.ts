import { OTTERWARE_DEV_URL_SCHEME, OTTERWARE_URL_SCHEME } from "./otterware.ts";
import { isLoopbackHost } from "./preview.ts";

// Otter Code desktop clients still connect to an Otterware server, so both apps' schemes return.
const DESKTOP_RETURN_PROTOCOLS = new Set([
  "ottercode:",
  "ottercode-dev:",
  `${OTTERWARE_URL_SCHEME}:`,
  `${OTTERWARE_DEV_URL_SCHEME}:`,
]);

/** Only return to a local client or the hosted T3 client, never an arbitrary OAuth-supplied URL. */
export function providerAuthReturnUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const desktop = DESKTOP_RETURN_PROTOCOLS.has(url.protocol) && url.host === "app";
    const web =
      ["http:", "https:"].includes(url.protocol) &&
      (isLoopbackHost(url.hostname) || url.origin === "https://code.otterware.app");
    if (
      url.username ||
      url.password ||
      (!desktop && !web) ||
      (url.pathname !== "/welcome" &&
        url.pathname !== "/settings" &&
        !url.pathname.startsWith("/settings/"))
    )
      return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        url.pathname === "/welcome" ||
        !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/u.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
