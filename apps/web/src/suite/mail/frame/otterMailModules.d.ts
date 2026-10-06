/**
 * Otter Mail's renderer modules, vendored in vendor/otter-mail/apps/web and
 * resolved by apps/web/vite/otterMailFrame.ts. This boundary is excluded
 * from Otter Code's main web TypeScript program.
 */
declare module "otter-mail:renderer" {}

declare module "otter-mail:settings-search" {
  export const SETTINGS_SECTION_LABELS: Readonly<Record<string, string>>;
}
