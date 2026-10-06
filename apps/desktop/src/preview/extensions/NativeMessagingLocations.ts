// @effect-diagnostics nodeBuiltinImport:off -- Chrome's native host locations at the Electron boundary.
import { app } from "electron";
import * as NodePath from "node:path";

export function nativeMessagingDirectories(
  platform: NodeJS.Platform,
  configHome?: string,
): string[] {
  const own = NodePath.join(app.getPath("userData"), "NativeMessagingHosts");
  if (platform === "darwin") {
    const support = NodePath.join(app.getPath("home"), "Library/Application Support");
    return [
      own,
      NodePath.join(support, "Google/Chrome/NativeMessagingHosts"),
      NodePath.join(support, "Chromium/NativeMessagingHosts"),
      "/Library/Google/Chrome/NativeMessagingHosts",
      "/Library/Application Support/Chromium/NativeMessagingHosts",
    ];
  }
  if (platform === "linux") {
    const config = configHome || NodePath.join(app.getPath("home"), ".config");
    return [
      own,
      NodePath.join(config, "google-chrome/NativeMessagingHosts"),
      NodePath.join(config, "chromium/NativeMessagingHosts"),
      "/etc/opt/chrome/native-messaging-hosts",
      "/etc/chromium/native-messaging-hosts",
      "/etc/chromium-browser/native-messaging-hosts",
    ];
  }
  return [own];
}
