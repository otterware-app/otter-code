/**
 * Chrome extensions in the desktop browser preview: what the desktop bridge's
 * `previewExtensions` gives the preview's toolbar and Settings.
 */

/** An installed extension, on or off. */
export interface DesktopPreviewExtension {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  /** A data: URL of its icon (about 64px), if it has one. */
  readonly icon: string | null;
  /** Whether it has an options page (`openOptions` shows it). */
  readonly hasOptions: boolean;
  readonly enabled: boolean;
  /** What it may read, in a sentence. */
  readonly siteAccess: string;
  readonly permissions: ReadonlyArray<string>;
}

/** An extension's toolbar button for one tab: Chrome's `chrome.action`. */
export interface DesktopPreviewExtensionAction {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  /** A data: URL, if it has an icon. */
  readonly icon: string | null;
  readonly badgeText: string;
  readonly badgeBackgroundColor: string;
  readonly badgeTextColor: string;
  readonly hasPopup: boolean;
  readonly enabled: boolean;
  readonly hasOptions: boolean;
}

/** A toolbar button's box in the window, in CSS pixels: an extension's popup hangs from it. */
export interface DesktopPreviewExtensionAnchor {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesktopPreviewExtensionsBridge {
  /** Every installed extension, on or off. */
  list: () => Promise<ReadonlyArray<DesktopPreviewExtension>>;
  /** The toolbar's buttons for the tab showing in `webContentsId`. */
  actions: (webContentsId: number) => Promise<ReadonlyArray<DesktopPreviewExtensionAction>>;
  /** A toolbar button clicked: the extension's popup under `anchor`, or its click handler. */
  runAction: (input: {
    readonly extensionId: string;
    readonly webContentsId: number;
    readonly anchor: DesktopPreviewExtensionAnchor;
  }) => Promise<void>;
  /** The tab now showing in a preview: Chrome's active tab. */
  setActiveTab: (webContentsId: number) => Promise<void>;
  openOptions: (extensionId: string) => Promise<void>;
  /** The Chrome Web Store, in a window of its own (from Settings, beside no thread). */
  openWebStore: () => Promise<void>;
  setEnabled: (extensionId: string, enabled: boolean) => Promise<void>;
  remove: (extensionId: string) => Promise<void>;
  /** Developer mode: an extension from a folder the user picks. */
  loadUnpacked: () => Promise<DesktopPreviewExtension | null>;
  /** Extensions were added, turned on or off, or removed, or their buttons changed. */
  onChanged: (listener: () => void) => () => void;
  /** An extension opened a web page, which belongs in a preview tab. */
  onOpenTab: (listener: (url: string) => void) => () => void;
}
