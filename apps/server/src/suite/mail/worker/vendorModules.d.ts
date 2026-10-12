/**
 * Mail's desktop services, vendored verbatim under vendor/otter-mail/apps/desktop.
 * The bundler (`buildMailWorker.ts`) resolves these names to them and their
 * Electron imports to `./shims`; the worker program sees only their exports.
 */
declare module "otter-mail-desktop/gmail-oauth" {
  import type { GoogleAuth } from "@otter-mail/core";
  export const googleAuth: GoogleAuth;
}

declare module "otter-mail-desktop/microsoft-oauth" {
  import type { MicrosoftAuth } from "@otter-mail/core";
  export const microsoftAuth: MicrosoftAuth;
}

declare module "otter-mail-desktop/mail-socket" {
  import type { Platform } from "@otter-mail/core";
  export const connectMailSocket: Platform["connect"];
}

declare module "otter-mail-desktop/todoist-oauth" {
  import type { Platform } from "@otter-mail/core";
  export const todoistSignIn: NonNullable<Platform["todoistSignIn"]>;
}
