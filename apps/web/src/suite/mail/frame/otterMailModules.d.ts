/**
 * Otter Mail's renderer modules, vendored in vendor/otter-mail/apps/web and
 * resolved by apps/web/vite/otterMailFrame.ts. These declarations keep the
 * vendor renderer behind its adapter boundary in the web TypeScript program.
 */
declare module "otter-mail:renderer" {}

declare module "otter-mail:settings-search" {
  export const SETTINGS_SECTION_LABELS: Readonly<Record<string, string>>;
}
