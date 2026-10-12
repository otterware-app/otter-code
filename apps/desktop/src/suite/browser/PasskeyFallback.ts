// @effect-diagnostics globalTimers:off -- Electron guest IPC is outside the Effect runtime.
import { BrowserWindow, dialog, shell, type WebContents } from "electron";
import { getPublicSuffix } from "tldts";

export const PASSKEY_FALLBACK_CHANNEL = "otterware:passkey-browser-fallback";

/** An extension URL cannot be opened externally. Use a validated RP site, never an arbitrary supplied URL. */
export function passkeyFallbackUrl(frameUrl: string, rpId: unknown): string | null {
  if (!URL.canParse(frameUrl)) return null;
  const page = new URL(frameUrl);
  if (
    page.protocol === "https:" ||
    (page.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(page.hostname))
  )
    return page.toString();
  if (page.protocol !== "chrome-extension:" || typeof rpId !== "string") return null;
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(rpId) ||
    getPublicSuffix(rpId, { allowPrivateDomains: true }) === rpId
  )
    return null;
  // Bitwarden's passkey RP is its parent domain; the web vault is the login destination.
  if (rpId === "bitwarden.com" || rpId === "bitwarden.eu") return `https://vault.${rpId}/#/login`;
  return `https://${rpId}/`;
}

const pending = new WeakSet<WebContents>();
const attached = new WeakSet<WebContents>();

export async function offerPasskeyFallback(contents: WebContents, rpId?: unknown) {
  if (contents.isDestroyed() || !contents.isFocused() || pending.has(contents)) return;
  const url = passkeyFallbackUrl(contents.mainFrame.url, rpId);
  if (url === null) return;
  pending.add(contents);
  try {
    // A dialog blurs (and closes) toolbar popups, so parent it to the app window.
    const owner =
      BrowserWindow.fromWebContents(contents.hostWebContents ?? contents)?.getParentWindow() ??
      BrowserWindow.fromWebContents(contents.hostWebContents ?? contents);
    const options: Electron.MessageBoxOptions = {
      type: "info",
      message: "Continue in your browser",
      detail: `This passkey request could not be completed here. Your system browser can use Touch ID and your saved passkeys.\n\n${url}\n\nSign in again there. Browser login does not unlock an extension inside Otterware.`,
      buttons: ["Continue in your browser", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const { response } = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
    if (response === 0) await shell.openExternal(url);
  } finally {
    pending.delete(contents);
  }
}

export function attachPasskeyFallback(contents: WebContents) {
  if (attached.has(contents)) return;
  attached.add(contents);
  contents.ipc.handle(PASSKEY_FALLBACK_CHANNEL, (event, rpId: unknown) => {
    if (event.senderFrame !== contents.mainFrame) return;
    return offerPasskeyFallback(contents, rpId).catch(() => {});
  });
}
