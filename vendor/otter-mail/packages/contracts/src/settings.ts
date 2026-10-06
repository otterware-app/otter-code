/** App preference defaults shared by the backend and settings UI. */

export type NotificationsMode = "off" | "inbox" | "all";

export type AppSettings = {
  /** Periodic pull-sync interval in seconds; 0 disables the timer. */
  syncIntervalSeconds: number;
  /** New-mail notifications: off, inbox-only, or every new message. */
  notificationsMode: NotificationsMode;
  /** Automatically open the app when the user logs in. */
  launchAtLogin: boolean;
  /** Show the unread count on the Dock icon (Mac app). */
  dockBadgeEnabled: boolean;
  /** Languages the user reads (BCP-47 codes, first = where translations go).
      Empty until set: the renderer then falls back to the system languages. */
  readLanguages: string[];
  /** Translate mail in other languages without asking. */
  autoTranslate: boolean;
};

export const DEFAULT_SETTINGS: AppSettings = {
  syncIntervalSeconds: 30,
  notificationsMode: "inbox",
  launchAtLogin: false,
  dockBadgeEnabled: false,
  readLanguages: [],
  autoTranslate: false,
};
