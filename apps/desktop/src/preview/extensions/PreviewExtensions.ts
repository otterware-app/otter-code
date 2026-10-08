// @effect-diagnostics nodeBuiltinImport:off -- Extensions are folders Electron loads by path.
// @effect-diagnostics globalTimers:off -- Electron's callbacks (workers, popups, IPC) run outside any Effect fiber.
// @effect-diagnostics globalDate:off -- A failed worker's retry delay, at the same native boundary.
// @effect-diagnostics globalConsole:off -- Extensions' failures, logged where Electron reports them.
/**
 * Chrome extensions in the browser preview.
 *
 * Electron runs an extension's worker, its pages and its content scripts, but
 * none of Chrome's toolbar, tab strip or windows. This adds them: the Chrome
 * Web Store installs extensions (electron-chrome-web-store), the preview's
 * toolbar shows their buttons and popups, and what Electron lacks of
 * `chrome.action`, `chrome.tabs`, `chrome.windows` and friends arrives here
 * from preview-extensions-preload.ts.
 *
 * Each persistent preview partition (one per environment and profile) is a
 * Chrome profile: the same extensions load into all of them, and each runs its
 * own workers and sees only its own tabs. Incognito partitions get none, as in
 * Chrome. Tabs are the preview's webview guests, plus the windows extensions
 * open their own pages in, each known by its webContents id.
 */

import {
  BrowserWindow,
  Menu,
  Notification,
  app,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
  webContents as allWebContents,
  webFrameMain,
  type ContextMenuParams,
  type Extension,
  type IpcMainInvokeEvent,
  type IpcMainServiceWorkerInvokeEvent,
  type MenuItemConstructorOptions,
  type ServiceWorkerMain,
  type Session,
  type WebContents,
  type WebFrameMain,
} from "electron";
import type {
  DesktopPreviewExtension,
  DesktopPreviewExtensionAction,
  DesktopPreviewExtensionAnchor,
} from "@t3tools/contracts";
import type { installChromeWebStore } from "electron-chrome-web-store";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Channels from "./channels.ts";
import { enableNativeMessaging } from "./NativeMessagingIPC.ts";

/** The parts of an extension's manifest.json read here. */
type Manifest = {
  name?: string;
  version?: string;
  description?: string;
  default_locale?: string;
  icons?: { [size: number]: string };
  action?: {
    default_title?: string;
    default_icon?: string | { [size: number]: string };
    default_popup?: string;
  };
  options_page?: string;
  options_ui?: { page?: string };
  permissions?: string[];
  host_permissions?: string[];
  content_scripts?: { matches?: string[] }[];
  commands?: Record<string, { description?: string; suggested_key?: Record<string, string> }>;
  background?: { service_worker?: string };
};

const manifestOf = (extension: Extension) => extension.manifest as Manifest;

const WEB_STORE_URL = "https://chromewebstore.google.com/category/extensions";

// ── Profiles: the partitions extensions run in ───────────────────────

type Profile = {
  readonly session: Session;
  /** The events each extension listens to (its worker wakes for those). */
  readonly listening: Map<string, Set<string>>;
  /** Extension pages (popups, options) that listen, by extension. */
  readonly pages: Map<string, Set<WebContents>>;
  /** Waits for an extension to (re)start listening to an event, by `${id} ${name}`. */
  readonly listenWaiters: Map<string, Array<() => void>>;
  /** Workers that just failed to start, and when: they aren't retried for a while. */
  readonly failedWorkers: Map<string, number>;
  readonly starting: Map<string, Promise<ServiceWorkerMain | null>>;
  /** The tab last shown in this profile: Chrome's active tab. */
  activeTabId: number;
};

const profiles = new Map<Session, Profile>();

const firstProfile = (): Profile | undefined => profiles.values().next().value;

// ── Tabs ─────────────────────────────────────────────────────────────

type Tab = { readonly contents: WebContents; readonly profile: Profile; favicon: string | null };

const tabs = new Map<number, Tab>();

const tabIdsOf = (profile: Profile) =>
  [...tabs.entries()].filter(([, tab]) => tab.profile === profile).map(([tabId]) => tabId);

/** The window a tab shows in: a webview's host window, or a page window's own. */
const windowOfContents = (contents: WebContents) =>
  BrowserWindow.fromWebContents(contents.hostWebContents ?? contents);

/** A page shows its address to extensions that may read it (Chrome's rule). */
function seesPage(extension: Extension | null, tabId: number): boolean {
  if (!extension) return true;
  const manifest = manifestOf(extension);
  const permissions = manifest.permissions ?? [];
  return (
    permissions.includes("tabs") ||
    (manifest.host_permissions ?? []).length > 0 ||
    (permissions.includes("activeTab") && tabId === tabs.get(tabId)?.profile.activeTabId)
  );
}

function tabOf(tabId: number, extension: Extension | null = null) {
  const tab = tabs.get(tabId);
  if (!tab || tab.contents.isDestroyed()) return null;
  const { contents, profile, favicon } = tab;
  const active = tabId === profile.activeTabId;
  return {
    id: tabId,
    index: tabIdsOf(profile).indexOf(tabId),
    windowId: windowOfContents(contents)?.id ?? -1,
    active,
    highlighted: active,
    selected: active,
    pinned: false,
    incognito: false,
    discarded: false,
    autoDiscardable: true,
    frozen: false,
    groupId: -1,
    status: contents.isLoading() ? "loading" : "complete",
    audible: contents.isCurrentlyAudible(),
    mutedInfo: { muted: contents.isAudioMuted() },
    ...(seesPage(extension, tabId)
      ? { url: contents.getURL(), title: contents.getTitle(), favIconUrl: favicon ?? undefined }
      : {}),
  };
}

function windowOf(
  window: BrowserWindow,
  profile: Profile,
  populate: boolean,
  extension: Extension | null,
) {
  const bounds = window.getBounds();
  const windowTabs = tabIdsOf(profile).filter(
    (tabId) => windowOfContents(tabs.get(tabId)!.contents) === window,
  );
  return {
    id: window.id,
    focused: window.isFocused(),
    top: bounds.y,
    left: bounds.x,
    width: bounds.width,
    height: bounds.height,
    incognito: false,
    alwaysOnTop: false,
    type: windowTabs.length > 0 ? "normal" : "popup",
    state: window.isFullScreen()
      ? "fullscreen"
      : window.isMinimized()
        ? "minimized"
        : window.isMaximized()
          ? "maximized"
          : "normal",
    ...(populate
      ? { tabs: windowTabs.map((tabId) => tabOf(tabId, extension)).filter(Boolean) }
      : {}),
  };
}

/** The app's windows: the renderers that drew a toolbar or Settings. */
const appRenderers = new Set<WebContents>();

function appWindow(profile?: Profile): BrowserWindow | null {
  const host =
    (profile && tabs.get(profile.activeTabId)?.contents.hostWebContents) ??
    [...tabs.values()].find((tab) => tab.profile === profile && tab.contents.hostWebContents)
      ?.contents.hostWebContents;
  const hostWindow = host ? BrowserWindow.fromWebContents(host) : null;
  if (hostWindow) return hostWindow;
  const windows = [...appRenderers]
    .map((renderer) => BrowserWindow.fromWebContents(renderer))
    .filter((window): window is BrowserWindow => window !== null && !window.isDestroyed());
  return windows.find((window) => window.isFocused()) ?? windows[0] ?? null;
}

/** The window an extension's call means by "current": the caller's own, or its profile's active tab's. */
function currentWindow(caller: Caller): BrowserWindow | null {
  const own = caller.sender && tabs.has(caller.sender.id) ? caller.sender : null;
  const active = tabs.get(caller.profile.activeTabId)?.contents;
  const contents = own ?? active;
  return (contents && windowOfContents(contents)) ?? appWindow(caller.profile);
}

/** Tabs an extension opened, waiting for their page to arrive. */
const creating: Array<{
  readonly profile: Profile;
  readonly url: string;
  readonly resolve: (tabId: number | null) => void;
}> = [];

function trackTab(contents: WebContents, profile: Profile): void {
  const tabId = contents.id;
  if (tabs.has(tabId)) return;
  tabs.set(tabId, { contents, profile, favicon: null });
  const updated = (change: Record<string, unknown>) =>
    emit(profile, (extension) => ["tabs.onUpdated", [tabId, change, tabOf(tabId, extension)]]);
  let fresh = true;
  contents.on("did-start-loading", () => updated({ status: "loading" }));
  contents.on("did-stop-loading", () => updated({ status: "complete" }));
  contents.on("did-navigate", (_event, url) => {
    updated({ url });
    if (!fresh) return;
    fresh = false;
    const waiting = creating.findIndex(
      (pending) => pending.profile === profile && pending.url === URL.parse(url)?.href,
    );
    if (waiting >= 0) creating.splice(waiting, 1)[0]!.resolve(tabId);
  });
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) updated({ url });
  });
  contents.on("page-title-updated", (_event, title) => updated({ title }));
  contents.on("page-favicon-updated", (_event, favicons) => {
    const tab = tabs.get(tabId);
    if (tab) tab.favicon = favicons[0] ?? null;
    updated({ favIconUrl: favicons[0] });
  });
  // webNavigation, frame by frame (Chrome's frame ids: 0 for the page itself).
  const navigation = (name: string, frame: WebFrameMain | null | undefined, extra = {}) => {
    if (!frame) return;
    emit(profile, () => [
      `webNavigation.${name}`,
      [
        {
          tabId,
          frameId: frameIdOf(contents, frame),
          parentFrameId: frame.parent ? frameIdOf(contents, frame.parent) : -1,
          url: frame.url,
          processId: frame.processId,
          timeStamp: Date.now(),
          ...extra,
        },
      ],
    ]);
  };
  contents.on("did-start-navigation", (details) => {
    if (!details.isSameDocument) {
      navigation("onBeforeNavigate", details.frame, { url: details.url });
    }
  });
  contents.on(
    "did-frame-navigate",
    (_event, url, _code, _status, isMainFrame, processId, routingId) =>
      navigation("onCommitted", frameOf(processId, routingId), {
        url,
        transitionType: isMainFrame ? "link" : "auto_subframe",
        transitionQualifiers: [],
      }),
  );
  contents.on("dom-ready", () => navigation("onDOMContentLoaded", contents.mainFrame));
  contents.on("did-frame-finish-load", (_event, _isMainFrame, processId, routingId) =>
    navigation("onCompleted", frameOf(processId, routingId)),
  );
  contents.on(
    "did-fail-load",
    (_event, code, description, url, _isMainFrame, processId, routingId) => {
      // -3 is an aborted load: the page went elsewhere.
      if (code !== -3) {
        navigation("onErrorOccurred", frameOf(processId, routingId), { url, error: description });
      }
    },
  );
  contents.on("did-navigate-in-page", (_event, url, isMainFrame, processId, routingId) => {
    navigation(
      URL.parse(url)?.hash ? "onReferenceFragmentUpdated" : "onHistoryStateUpdated",
      isMainFrame ? contents.mainFrame : frameOf(processId, routingId),
      { url, transitionType: "link", transitionQualifiers: [] },
    );
  });
  contents.once("destroyed", () => {
    tabs.delete(tabId);
    for (const state of actions.values()) state.tabs.delete(tabId);
    if (profile.activeTabId === tabId) profile.activeTabId = -1;
    emit(profile, () => ["tabs.onRemoved", [tabId, { windowId: -1, isWindowClosing: false }]]);
    notifyChanged();
  });
  emit(profile, (extension) => ["tabs.onCreated", [tabOf(tabId, extension)]]);
}

function frameIdOf(contents: WebContents, frame: WebFrameMain): number {
  return frame === contents.mainFrame ? 0 : frame.frameTreeNodeId;
}

function frameOf(processId: number, routingId: number): WebFrameMain | undefined {
  return webFrameMain.fromId(processId, routingId) ?? undefined;
}

function frameInfo(contents: WebContents, frame: WebFrameMain) {
  return {
    frameId: frameIdOf(contents, frame),
    parentFrameId: frame.parent ? frameIdOf(contents, frame.parent) : -1,
    url: frame.url,
    processId: frame.processId,
    errorOccurred: false,
  };
}

function setActiveTab(tabId: number): void {
  const tab = tabs.get(tabId);
  if (!tab || tab.profile.activeTabId === tabId) return;
  tab.profile.activeTabId = tabId;
  emit(tab.profile, () => [
    "tabs.onActivated",
    [{ tabId, windowId: windowOfContents(tab.contents)?.id ?? -1 }],
  ]);
  notifyChanged();
}

/**
 * A tab an extension opens: a web page in a preview tab beside the thread
 * showing (the renderer opens it), an extension's own page in a window.
 */
function createTab(profile: Profile, rawUrl: string, active = true): Promise<number | null> {
  const url = URL.parse(rawUrl)?.href;
  if (url?.startsWith("chrome-extension:")) {
    return Promise.resolve(openPageWindow(profile, url, { show: active }).webContents.id);
  }
  const window = appWindow(profile);
  if (!url || !/^https?:/.test(url) || !window) return Promise.resolve(null);
  window.webContents.send(Channels.OPEN_TAB_CHANNEL, url);
  return new Promise((resolve) => {
    const pending = { profile, url, resolve };
    creating.push(pending);
    setTimeout(() => {
      const at = creating.indexOf(pending);
      if (at < 0) return;
      creating.splice(at, 1);
      resolve(null);
    }, 5_000);
  });
}

/** An extension's own page (its options, a window it asked for), in a window of its profile. */
function openPageWindow(
  profile: Profile,
  url: string,
  options: { width?: number; height?: number; show?: boolean } = {},
): BrowserWindow {
  const window = new BrowserWindow({
    width: options.width ?? 1024,
    height: options.height ?? 768,
    show: options.show ?? true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#202020" : "#ffffff",
    webPreferences: {
      session: profile.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  preparePage(profile, window.webContents);
  trackTab(window.webContents, profile);
  void window.loadURL(url);
  return window;
}

/** Around an extension's page: links open as tabs, and a context menu to edit and inspect. */
function preparePage(profile: Profile, contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    void createTab(profile, url);
    return { action: "deny" };
  });
  contents.on("context-menu", (_event, params) => {
    const window = BrowserWindow.fromWebContents(contents);
    Menu.buildFromTemplate([
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { type: "separator" },
      { label: "Inspect", click: () => contents.inspectElement(params.x, params.y) },
    ]).popup(window ? { window } : {});
  });
}

/** Resolves an extension's relative URL ("options.html") against its own origin. */
function absolute(extensionId: string, url: string): string {
  return new URL(url, `chrome-extension://${extensionId}/`).href;
}

// ── Events, to extensions' workers and pages ─────────────────────────

function onListen(profile: Profile, extensionId: string, name: string, page?: WebContents): void {
  const names = profile.listening.get(extensionId) ?? new Set();
  profile.listening.set(extensionId, names);
  names.add(name);
  if (page) {
    const set = profile.pages.get(extensionId) ?? new Set();
    profile.pages.set(extensionId, set);
    if (!set.has(page)) {
      set.add(page);
      page.once("destroyed", () => set.delete(page));
    }
  }
  const key = `${extensionId} ${name}`;
  for (const resolve of profile.listenWaiters.get(key) ?? []) resolve();
  profile.listenWaiters.delete(key);
}

function runningWorker(profile: Profile, extensionId: string): ServiceWorkerMain | undefined {
  const scope = `chrome-extension://${extensionId}/`;
  const workers = profile.session.serviceWorkers;
  for (const [versionId, info] of Object.entries(workers.getAllRunning())) {
    if (info.scope === scope) return workers.getWorkerFromVersionID(Number(versionId));
  }
  return undefined;
}

const RETRY_FAILED_WORKER_MS = 60_000;

/** The extension's background worker, started if it sleeps (it listens again as it starts). */
async function wakeWorker(
  profile: Profile,
  extensionId: string,
  name: string,
): Promise<ServiceWorkerMain | null> {
  const running = runningWorker(profile, extensionId);
  if (running) return running;
  if (Date.now() - (profile.failedWorkers.get(extensionId) ?? 0) < RETRY_FAILED_WORKER_MS) {
    return null;
  }
  const extension = profile.session.extensions.getExtension(extensionId);
  if (!extension || !manifestOf(extension).background?.service_worker) return null;
  const key = `${extensionId} ${name}`;
  const listened = new Promise<void>((resolve) => {
    profile.listenWaiters.set(key, [...(profile.listenWaiters.get(key) ?? []), resolve]);
    setTimeout(resolve, 2_000);
  });
  // Events arriving together share one start.
  let start = profile.starting.get(extensionId);
  if (!start) {
    start = profile.session.serviceWorkers
      .startWorkerForScope(`chrome-extension://${extensionId}/`)
      .catch((error: unknown) => {
        profile.failedWorkers.set(extensionId, Date.now());
        console.warn("Couldn't start an extension's worker", { extensionId, error: String(error) });
        return null;
      })
      .finally(() => profile.starting.delete(extensionId));
    profile.starting.set(extensionId, start);
  }
  const worker = await start;
  if (worker) await listened;
  return worker;
}

async function deliver(
  profile: Profile,
  extensionId: string,
  name: string,
  args: unknown[],
): Promise<void> {
  for (const page of profile.pages.get(extensionId) ?? []) {
    if (!page.isDestroyed()) page.send(Channels.CRX_EVENT_CHANNEL, name, args);
  }
  const worker = await wakeWorker(profile, extensionId, name);
  worker?.send(Channels.CRX_EVENT_CHANNEL, name, args);
}

/** Sends an event to every extension of `profile` listening for it; `make` tailors it to each. */
function emit(profile: Profile, make: (extension: Extension) => [string, unknown[]]): void {
  for (const [extensionId, names] of profile.listening) {
    const extension = profile.session.extensions.getExtension(extensionId);
    if (!extension) continue;
    const [name, args] = make(extension);
    if (names.has(name)) void deliver(profile, extensionId, name, args);
  }
}

// ── The toolbar: chrome.action ───────────────────────────────────────

type ActionDetails = {
  title?: string;
  icon?: string | null;
  popup?: string;
  badgeText?: string;
  badgeBackgroundColor?: string;
  badgeTextColor?: string;
  enabled?: boolean;
};

/** What each extension changed, for every tab and for single tabs. */
const actions = new Map<string, { all: ActionDetails; tabs: Map<number, ActionDetails> }>();

function actionState(extensionId: string) {
  const state = actions.get(extensionId) ?? { all: {}, tabs: new Map() };
  actions.set(extensionId, state);
  return state;
}

/** The icon file for about `size` px from a manifest's `{ "16": …, "32": … }` (or one path). */
function iconFile(icons: string | { [size: number]: string } | undefined, size: number) {
  if (!icons || typeof icons === "string") return icons;
  const sizes = Object.keys(icons)
    .map(Number)
    .toSorted((a, b) => a - b);
  const best = sizes.find((each) => each >= size) ?? sizes.at(-1);
  return best === undefined ? undefined : icons[best];
}

function iconDataUrl(dir: string, file: string | undefined): string | null {
  if (!file) return null;
  const image = nativeImage.createFromPath(NodePath.join(dir, file.replace(/^\//, "")));
  return image.isEmpty() ? null : image.toDataURL();
}

/** A manifest string, with Chrome's `__MSG_name__` looked up in the extension's default locale. */
function localized(dir: string, manifest: Manifest, value: string | undefined) {
  const key = value?.match(/^__MSG_(\w+)__$/)?.[1]?.toLowerCase();
  if (!key) return value;
  try {
    const file = NodePath.join(dir, "_locales", manifest.default_locale ?? "en", "messages.json");
    const messages = JSON.parse(NodeFS.readFileSync(file, "utf8")) as Record<
      string,
      { message?: string }
    >;
    return (
      Object.entries(messages).find(([name]) => name.toLowerCase() === key)?.[1].message ?? value
    );
  } catch {
    return value;
  }
}

function resolvedAction(extension: Extension, tabId: number) {
  const manifest = manifestOf(extension);
  const state = actionState(extension.id);
  const changed = { ...state.all, ...state.tabs.get(tabId) };
  return {
    title:
      changed.title ??
      localized(extension.path, manifest, manifest.action?.default_title) ??
      extension.name,
    icon:
      changed.icon ??
      iconDataUrl(extension.path, iconFile(manifest.action?.default_icon ?? manifest.icons, 32)),
    popup: changed.popup ?? manifest.action?.default_popup ?? "",
    badgeText: changed.badgeText ?? "",
    badgeBackgroundColor: changed.badgeBackgroundColor ?? "#5f6368",
    badgeTextColor: changed.badgeTextColor ?? "#ffffff",
    enabled: changed.enabled ?? true,
  };
}

/** Chrome takes a color as a string or [r, g, b, a]. */
function cssColor(color: unknown): string | undefined {
  if (typeof color === "string") return color;
  if (Array.isArray(color) && color.length >= 3) {
    const [r, g, b, a = 255] = color as number[];
    return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
  }
  return undefined;
}

/** `setIcon`'s pixels (RGBA from an ImageData) or path, as a data: URL. */
function iconFromDetails(extension: Extension, details: Record<string, unknown>): string | null {
  const imageData = details.imageData as
    | Record<string, { width: number; height: number; data: number[] }>
    | { width: number; height: number; data: number[] }
    | undefined;
  if (imageData) {
    const sets =
      "data" in imageData && Array.isArray(imageData.data)
        ? [imageData as { width: number; height: number; data: number[] }]
        : Object.values(
            imageData as Record<string, { width: number; height: number; data: number[] }>,
          );
    const largest = sets.toSorted((a, b) => b.width - a.width)[0];
    if (!largest) return null;
    const bgra = Buffer.alloc(largest.data.length);
    for (let i = 0; i < largest.data.length; i += 4) {
      bgra[i] = largest.data[i + 2]!;
      bgra[i + 1] = largest.data[i + 1]!;
      bgra[i + 2] = largest.data[i]!;
      bgra[i + 3] = largest.data[i + 3]!;
    }
    const image = nativeImage.createFromBitmap(bgra, {
      width: largest.width,
      height: largest.height,
    });
    return image.isEmpty() ? null : image.toDataURL();
  }
  const file = iconFile(details.path as string | { [size: number]: string } | undefined, 32);
  return iconDataUrl(extension.path, file);
}

let changedTimer: NodeJS.Timeout | null = null;

/** Tells the app's windows to read the extensions and their buttons again (once per burst). */
function notifyChanged(): void {
  if (changedTimer) return;
  changedTimer = setTimeout(() => {
    changedTimer = null;
    for (const renderer of appRenderers) {
      if (!renderer.isDestroyed()) renderer.send(Channels.CHANGED_CHANNEL);
    }
  }, 30);
}

function extensionActions(tabId: number): DesktopPreviewExtensionAction[] {
  const profile = tabs.get(tabId)?.profile ?? firstProfile();
  if (!profile) return [];
  return profile.session.extensions
    .getAllExtensions()
    .map((extension) => {
      const action = resolvedAction(extension, tabId);
      return {
        id: extension.id,
        name: extension.name,
        title: action.title,
        icon: action.icon,
        badgeText: action.badgeText,
        badgeBackgroundColor: action.badgeBackgroundColor,
        badgeTextColor: action.badgeTextColor,
        hasPopup: Boolean(action.popup),
        enabled: action.enabled,
        hasOptions: optionsUrlOf(extension.id, manifestOf(extension)) !== null,
      };
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/** A toolbar button clicked: its popup under `anchor`, or the extension's onClicked. */
function runAction(
  owner: BrowserWindow,
  extensionId: string,
  tabId: number,
  anchor: DesktopPreviewExtensionAnchor,
): void {
  const tab = tabs.get(tabId);
  const extension = tab?.profile.session.extensions.getExtension(extensionId);
  if (!tab || !extension) return;
  setActiveTab(tabId);
  const action = resolvedAction(extension, tabId);
  if (!action.enabled) return;
  if (action.popup) {
    openPopup(owner, tab.profile, extension, action.popup, anchor);
    return;
  }
  void deliver(tab.profile, extensionId, "action.onClicked", [tabOf(tabId, extension)]);
}

// ── Popups ───────────────────────────────────────────────────────────

let popup: BrowserWindow | null = null;
/** Where the last popup hung from, for `chrome.action.openPopup`. */
let lastPopup: { owner: BrowserWindow; anchor: DesktopPreviewExtensionAnchor } | null = null;

/** An extension's popup: a borderless window under its button, sized to its page, gone on blur. */
function openPopup(
  owner: BrowserWindow,
  profile: Profile,
  extension: Extension,
  page: string,
  anchor: DesktopPreviewExtensionAnchor,
): void {
  popup?.close();
  lastPopup = { owner, anchor };
  // The anchor is in the app's CSS pixels; the app may be zoomed.
  const zoom = owner.webContents.getZoomFactor();
  const content = owner.getContentBounds();
  const right = content.x + Math.round((anchor.x + anchor.width) * zoom);
  const top = content.y + Math.round((anchor.y + anchor.height) * zoom) + 4;
  const window = new BrowserWindow({
    parent: owner,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    // Starts small, as Chrome's do, so the page's own size shows through.
    x: right - 25,
    y: top,
    width: 25,
    height: 25,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#202020" : "#ffffff",
    webPreferences: {
      session: profile.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      enablePreferredSizeMode: true,
    },
  });
  popup = window;
  // Chrome's bounds for a popup: 25×25 to 800×600, right-aligned to its button.
  const place = (width: number, height: number) => {
    const w = Math.min(800, Math.max(25, Math.ceil(width)));
    const h = Math.min(600, Math.max(25, Math.ceil(height)));
    window.setBounds({ x: Math.max(content.x, right - w), y: top, width: w, height: h });
    if (!window.isVisible()) window.show();
  };
  window.webContents.on("preferred-size-changed", (_event, size) => {
    if (!window.isDestroyed()) place(size.width, size.height);
  });
  window.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      if (!window.isDestroyed() && !window.isVisible()) window.show();
    }, 200);
  });
  window.on("blur", () => {
    if (!window.isDestroyed()) window.close();
  });
  window.on("closed", () => {
    if (popup === window) popup = null;
  });
  preparePage(profile, window.webContents);
  void window.loadURL(absolute(extension.id, page));
}

// ── Context menus, notifications ─────────────────────────────────────

type MenuItem = {
  id: string;
  title?: string;
  type?: string;
  checked?: boolean;
  contexts?: string[];
  parentId?: string;
  documentUrlPatterns?: string[];
  targetUrlPatterns?: string[];
  enabled?: boolean;
  visible?: boolean;
};

/** Each extension's context menu items, in the order made. */
const menus = new Map<string, Map<string, MenuItem>>();

const menuOf = (extensionId: string) => {
  const items = menus.get(extensionId) ?? new Map<string, MenuItem>();
  menus.set(extensionId, items);
  return items;
};

/** The extensions' items for a right-click in a preview page, for its context menu. */
export function extensionMenuItems(
  page: WebContents,
  params: ContextMenuParams,
): MenuItemConstructorOptions[] {
  const profile = profiles.get(page.session);
  if (!profile) return [];
  const contexts = new Set(["all"]);
  if (params.isEditable) contexts.add("editable");
  if (params.selectionText.trim()) contexts.add("selection");
  if (params.linkURL) contexts.add("link");
  if (
    params.mediaType === "image" ||
    params.mediaType === "video" ||
    params.mediaType === "audio"
  ) {
    contexts.add(params.mediaType);
  }
  if (contexts.size === 1) contexts.add("page");
  if (params.frameURL) contexts.add("frame");
  const pageUrl = page.getURL();
  const target = params.linkURL || params.srcURL;
  const shown = (item: MenuItem) =>
    item.visible !== false &&
    (item.contexts ?? ["page"]).some((context) => contexts.has(context)) &&
    (!item.documentUrlPatterns ||
      item.documentUrlPatterns.some((pattern) => urlMatches(pattern, pageUrl))) &&
    (!item.targetUrlPatterns ||
      (target !== "" && item.targetUrlPatterns.some((pattern) => urlMatches(pattern, target))));
  const groups: MenuItemConstructorOptions[] = [];
  for (const [extensionId, items] of menus) {
    const extension = profile.session.extensions.getExtension(extensionId);
    if (!extension) continue;
    const build = (parentId?: string): MenuItemConstructorOptions[] =>
      [...items.values()]
        .filter((item) => item.parentId === parentId && shown(item))
        .map((item) => {
          if (item.type === "separator") return { type: "separator" as const };
          const children = build(item.id);
          const info = {
            menuItemId: item.id,
            ...(item.parentId ? { parentMenuItemId: item.parentId } : {}),
            editable: params.isEditable,
            pageUrl,
            ...(params.frameURL ? { frameUrl: params.frameURL } : {}),
            ...(params.linkURL ? { linkUrl: params.linkURL } : {}),
            ...(params.srcURL ? { srcUrl: params.srcURL } : {}),
            ...(params.selectionText ? { selectionText: params.selectionText } : {}),
            ...(params.mediaType !== "none" ? { mediaType: params.mediaType } : {}),
          };
          return {
            label: (item.title ?? extension.name).replace(/%s/g, params.selectionText.slice(0, 40)),
            enabled: item.enabled !== false,
            ...(item.type === "checkbox" || item.type === "radio"
              ? { type: item.type, checked: Boolean(item.checked) }
              : {}),
            ...(children.length > 0
              ? { submenu: children }
              : {
                  click: () =>
                    void deliver(profile, extensionId, "contextMenus.onClicked", [
                      info,
                      tabOf(page.id, extension),
                    ]),
                }),
          };
        });
    const top = build();
    if (top.length === 0) continue;
    // One item shows as is; more go under the extension's name, as in Chrome.
    groups.push(top.length === 1 ? top[0]! : { label: extension.name, submenu: top });
  }
  return groups;
}

const notifications = new Map<string, Notification>();

function showNotification(
  profile: Profile,
  extension: Extension,
  id: string,
  options: Record<string, unknown>,
) {
  notifications.get(id)?.close();
  const iconUrl = typeof options.iconUrl === "string" ? options.iconUrl : "";
  const icon = iconUrl.startsWith("data:")
    ? nativeImage.createFromDataURL(iconUrl)
    : iconUrl
      ? nativeImage.createFromPath(NodePath.join(extension.path, iconUrl.replace(/^\//, "")))
      : undefined;
  const notification = new Notification({
    title: String(options.title ?? extension.name),
    body: String(options.message ?? ""),
    silent: Boolean(options.silent),
    ...(icon && !icon.isEmpty() ? { icon } : {}),
  });
  notification.on(
    "click",
    () => void deliver(profile, extension.id, "notifications.onClicked", [id]),
  );
  notification.on("close", () => {
    notifications.delete(id);
    void deliver(profile, extension.id, "notifications.onClosed", [id, true]);
  });
  notifications.set(id, notification);
  notification.show();
}

/** chrome.privacy's settings, per extension (the preview keeps none of Chrome's). */
const privacy = new Map<string, unknown>();

let downloadId = 0;

// ── chrome.* calls from extensions ───────────────────────────────────

/** Who's calling: an extension page in a profile (`sender`), or its worker (no sender). */
type Caller = { readonly profile: Profile; readonly sender: WebContents | null };

type Call = (extension: Extension, args: unknown[], caller: Caller) => unknown;

const tabIdOf = (value: unknown, caller: Caller) =>
  typeof value === "number" ? value : caller.profile.activeTabId;

/** `tabs.query`'s filters the preview can answer. */
function matches(
  tab: NonNullable<ReturnType<typeof tabOf>>,
  query: Record<string, unknown>,
  caller: Caller,
) {
  if (query.active !== undefined && tab.active !== query.active) return false;
  if (query.highlighted !== undefined && tab.highlighted !== query.highlighted) return false;
  if (
    (query.currentWindow || query.lastFocusedWindow) &&
    tab.windowId !== currentWindow(caller)?.id
  ) {
    return false;
  }
  if (typeof query.windowId === "number" && query.windowId >= 0 && tab.windowId !== query.windowId)
    return false;
  if (typeof query.status === "string" && tab.status !== query.status) return false;
  if (typeof query.title === "string" && tab.title !== query.title) return false;
  if (query.audible !== undefined && tab.audible !== query.audible) return false;
  if (query.url !== undefined) {
    const patterns = (Array.isArray(query.url) ? query.url : [query.url]) as string[];
    if (!tab.url || !patterns.some((pattern) => urlMatches(pattern, tab.url!))) return false;
  }
  return true;
}

/** Chrome's match patterns: <all_urls>, scheme://host/path with * wildcards. */
function urlMatches(pattern: string, url: string): boolean {
  if (pattern === "<all_urls>") return /^(https?|file|ftp):/.test(url);
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/^\\\*:/, "(https?):")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(url);
}

function setAction(
  key: keyof ActionDetails,
  value: (details: Record<string, unknown>, extension: Extension) => unknown,
): Call {
  return (extension, [details]) => {
    const record = (details ?? {}) as Record<string, unknown>;
    const state = actionState(extension.id);
    let target = state.all;
    if (typeof record.tabId === "number") {
      target = state.tabs.get(record.tabId) ?? {};
      state.tabs.set(record.tabId, target);
    }
    (target as Record<string, unknown>)[key] = value(record, extension);
    notifyChanged();
  };
}

function getAction(key: keyof ReturnType<typeof resolvedAction>): Call {
  return (extension, [details]) => {
    const tabId = (details as { tabId?: number } | undefined)?.tabId;
    return resolvedAction(extension, tabId ?? -1)[key];
  };
}

function windowsInfo(info: unknown) {
  return Boolean((info as { populate?: boolean } | undefined)?.populate);
}

const calls: Record<string, Call> = {
  "action.setTitle": setAction("title", (d) => d.title),
  "action.getTitle": getAction("title"),
  "action.setIcon": setAction("icon", (d, extension) => iconFromDetails(extension, d)),
  "action.setPopup": setAction("popup", (d) => d.popup),
  "action.getPopup": (extension, [details]) => {
    const page = resolvedAction(extension, (details as { tabId?: number })?.tabId ?? -1).popup;
    return page ? absolute(extension.id, page) : "";
  },
  "action.setBadgeText": setAction("badgeText", (d) => d.text ?? ""),
  "action.getBadgeText": getAction("badgeText"),
  "action.setBadgeBackgroundColor": setAction("badgeBackgroundColor", (d) => cssColor(d.color)),
  "action.getBadgeBackgroundColor": getAction("badgeBackgroundColor"),
  "action.setBadgeTextColor": setAction("badgeTextColor", (d) => cssColor(d.color)),
  "action.getBadgeTextColor": getAction("badgeTextColor"),
  "action.enable": (extension, [tabId], caller) =>
    setAction("enabled", () => true)(extension, [{ tabId }], caller),
  "action.disable": (extension, [tabId], caller) =>
    setAction("enabled", () => false)(extension, [{ tabId }], caller),
  "action.isEnabled": (extension, [tabId]) =>
    resolvedAction(extension, typeof tabId === "number" ? tabId : -1).enabled,
  "action.openPopup": (extension, _args, caller) => {
    const page = resolvedAction(extension, caller.profile.activeTabId).popup;
    const owner = lastPopup?.owner.isDestroyed() === false ? lastPopup.owner : appWindow();
    if (!page || !owner) return;
    // Without a button clicked yet, it hangs from the window's top right corner.
    const anchor = lastPopup?.anchor ?? {
      x: owner.getContentBounds().width / owner.webContents.getZoomFactor() - 40,
      y: 0,
      width: 32,
      height: 40,
    };
    openPopup(owner, caller.profile, extension, page, anchor);
  },
  "action.getUserSettings": () => ({ isOnToolbar: true }),

  "tabs.get": (extension, [tabId], caller) => tabOf(tabIdOf(tabId, caller), extension),
  "tabs.getCurrent": (extension, _args, caller) =>
    caller.sender && tabs.has(caller.sender.id) ? tabOf(caller.sender.id, extension) : undefined,
  "tabs.query": (extension, [query], caller) =>
    tabIdsOf(caller.profile)
      .map((tabId) => tabOf(tabId, extension))
      .filter((tab): tab is NonNullable<typeof tab> => tab !== null)
      .filter((tab) => matches(tab, (query ?? {}) as Record<string, unknown>, caller)),
  "tabs.create": async (extension, [properties], caller) => {
    const { url = "about:blank", active = true } = (properties ?? {}) as {
      url?: string;
      active?: boolean;
    };
    const tabId = await createTab(caller.profile, absolute(extension.id, url), active);
    return tabId === null ? undefined : tabOf(tabId, extension);
  },
  "tabs.update": async (extension, args, caller) => {
    const [first, second] = args;
    const tabId = typeof first === "number" ? first : caller.profile.activeTabId;
    const properties = ((typeof first === "number" ? second : first) ?? {}) as {
      url?: string;
      active?: boolean;
      muted?: boolean;
    };
    const contents = tabs.get(tabId)?.contents;
    if (!contents) return undefined;
    if (properties.url) {
      await contents.loadURL(absolute(extension.id, properties.url)).catch(() => undefined);
    }
    if (properties.muted !== undefined) contents.setAudioMuted(properties.muted);
    if (properties.active) setActiveTab(tabId);
    return tabOf(tabId, extension);
  },
  // An extension closes the windows it opened; preview tabs are the user's to close.
  "tabs.remove": (_extension, [ids]) => {
    for (const tabId of Array.isArray(ids) ? ids : [ids]) {
      const contents = tabs.get(tabId as number)?.contents;
      if (contents && !contents.hostWebContents) BrowserWindow.fromWebContents(contents)?.close();
    }
  },
  "tabs.goBack": (_extension, [tabId], caller) =>
    tabs.get(tabIdOf(tabId, caller))?.contents.navigationHistory.goBack(),
  "tabs.goForward": (_extension, [tabId], caller) =>
    tabs.get(tabIdOf(tabId, caller))?.contents.navigationHistory.goForward(),
  "tabs.captureVisibleTab": async (_extension, args, caller) => {
    const options = (args.find((arg) => typeof arg === "object" && arg !== null) ?? {}) as {
      format?: string;
      quality?: number;
    };
    const contents = tabs.get(caller.profile.activeTabId)?.contents;
    if (!contents) throw new Error("No tab is showing.");
    const image = await contents.capturePage();
    return options.format === "jpeg"
      ? `data:image/jpeg;base64,${image.toJPEG(options.quality ?? 92).toString("base64")}`
      : image.toDataURL();
  },

  "windows.get": (extension, [windowId, info], caller) => {
    const window = BrowserWindow.fromId(windowId as number) ?? currentWindow(caller);
    return window ? windowOf(window, caller.profile, windowsInfo(info), extension) : undefined;
  },
  "windows.getCurrent": (extension, [info], caller) => {
    const window = currentWindow(caller);
    return window ? windowOf(window, caller.profile, windowsInfo(info), extension) : undefined;
  },
  "windows.getLastFocused": (extension, [info], caller) => {
    const window = currentWindow(caller);
    return window ? windowOf(window, caller.profile, windowsInfo(info), extension) : undefined;
  },
  "windows.getAll": (extension, [info], caller) => {
    const windows = new Set(
      tabIdsOf(caller.profile)
        .map((tabId) => windowOfContents(tabs.get(tabId)!.contents))
        .filter((window): window is BrowserWindow => window !== null),
    );
    return [...windows].map((window) =>
      windowOf(window, caller.profile, windowsInfo(info), extension),
    );
  },
  // A web page opens as a preview tab; an extension's own page in a window of its own.
  "windows.create": async (extension, [data], caller) => {
    const { url, type, width, height, focused } = (data ?? {}) as {
      url?: string | string[];
      type?: string;
      width?: number;
      height?: number;
      focused?: boolean;
    };
    const first = Array.isArray(url) ? url[0] : url;
    if (!first) return undefined;
    const target = absolute(extension.id, first);
    if (type !== "popup" && type !== "panel" && /^https?:/.test(target)) {
      await createTab(caller.profile, target);
      const window = currentWindow(caller);
      return window ? windowOf(window, caller.profile, true, extension) : undefined;
    }
    const window = openPageWindow(caller.profile, target, {
      width: width ?? 420,
      height: height ?? 640,
      show: focused !== false,
    });
    return windowOf(window, caller.profile, true, extension);
  },
  "windows.update": (extension, [windowId, info], caller) => {
    const window = BrowserWindow.fromId(windowId as number);
    if (window && (info as { focused?: boolean } | undefined)?.focused) window.focus();
    return window ? windowOf(window, caller.profile, false, extension) : undefined;
  },
  // Only the windows extensions opened: never the app's.
  "windows.remove": (_extension, [windowId]) => {
    const window = BrowserWindow.fromId(windowId as number);
    if (window && profiles.has(window.webContents.session)) window.close();
  },

  "contextMenus.create": (extension, [properties]) => {
    const item = properties as MenuItem;
    menuOf(extension.id).set(item.id, item);
  },
  "contextMenus.update": (extension, [id, properties]) => {
    const items = menuOf(extension.id);
    const item = items.get(String(id));
    if (item) items.set(item.id, { ...item, ...(properties as Partial<MenuItem>), id: item.id });
  },
  "contextMenus.remove": (extension, [id]) => {
    const items = menuOf(extension.id);
    const drop = (each: string) => {
      items.delete(each);
      for (const child of [...items.values()].filter((item) => item.parentId === each)) {
        drop(child.id);
      }
    };
    drop(String(id));
  },
  "contextMenus.removeAll": (extension) => menus.delete(extension.id),

  "notifications.create": (extension, [id, options], caller) =>
    showNotification(
      caller.profile,
      extension,
      String(id),
      (options ?? {}) as Record<string, unknown>,
    ),
  "notifications.update": (extension, [id, options], caller) => {
    if (!notifications.has(String(id))) return false;
    showNotification(
      caller.profile,
      extension,
      String(id),
      (options ?? {}) as Record<string, unknown>,
    );
    return true;
  },
  "notifications.clear": (_extension, [id]) => {
    const notification = notifications.get(String(id));
    notification?.close();
    return Boolean(notification);
  },
  "notifications.getAll": () =>
    Object.fromEntries([...notifications.keys()].map((id) => [id, true])),
  "notifications.getPermissionLevel": () => "granted",

  "downloads.download": (_extension, [options], caller) => {
    const { url } = (options ?? {}) as { url?: string };
    if (!url || !/^https?:/.test(url)) throw new Error("Can't download that address.");
    caller.profile.session.downloadURL(url);
    return ++downloadId;
  },
  "downloads.search": () => [],
  "downloads.pause": () => undefined,
  "downloads.resume": () => undefined,
  "downloads.cancel": () => undefined,
  "downloads.erase": () => [],
  "downloads.open": () => undefined,
  "downloads.show": () => undefined,
  "downloads.showDefaultFolder": () => void shell.openPath(app.getPath("downloads")),

  "privacy.get": (extension, [name]) => {
    const key = `${extension.id} ${String(name)}`;
    return {
      value: privacy.has(key) ? privacy.get(key) : true,
      levelOfControl: "controllable_by_this_extension",
    };
  },
  "privacy.set": (extension, [name, details], caller) => {
    const value = (details as { value?: unknown } | undefined)?.value;
    privacy.set(`${extension.id} ${String(name)}`, value);
    void deliver(caller.profile, extension.id, `privacy.onChange:${String(name)}`, [
      { value, levelOfControl: "controlled_by_this_extension" },
    ]);
  },
  "privacy.clear": (extension, [name]) => privacy.delete(`${extension.id} ${String(name)}`),

  "webNavigation.getAllFrames": (_extension, [details]) => {
    const contents = tabs.get((details as { tabId?: number })?.tabId ?? -1)?.contents;
    return contents
      ? contents.mainFrame.framesInSubtree.map((frame) => frameInfo(contents, frame))
      : null;
  },
  "webNavigation.getFrame": (_extension, [details]) => {
    const { tabId, frameId } = (details ?? {}) as { tabId?: number; frameId?: number };
    const contents = tabs.get(tabId ?? -1)?.contents;
    const frame = contents?.mainFrame.framesInSubtree.find(
      (each) => frameIdOf(contents, each) === frameId,
    );
    return contents && frame ? frameInfo(contents, frame) : null;
  },

  // What the manifest asked for is what it has; nothing optional is granted later.
  "permissions.contains": (extension, [request]) => {
    const manifest = manifestOf(extension);
    const { permissions = [], origins = [] } = (request ?? {}) as {
      permissions?: string[];
      origins?: string[];
    };
    const hosts = manifest.host_permissions ?? [];
    return (
      permissions.every((each) => (manifest.permissions ?? []).includes(each)) &&
      origins.every((origin) =>
        hosts.some((host) => host === origin || urlMatches(host, origin.replace(/\*/g, "x"))),
      )
    );
  },
  "permissions.getAll": (extension) => ({
    permissions: manifestOf(extension).permissions ?? [],
    origins: manifestOf(extension).host_permissions ?? [],
  }),
  "permissions.request": (extension, args, caller) =>
    calls["permissions.contains"]!(extension, args, caller),
  "permissions.remove": () => false,
  "permissions.addHostAccessRequest": () => undefined,
  "permissions.removeHostAccessRequest": () => undefined,

  "commands.getAll": (extension) =>
    Object.entries(manifestOf(extension).commands ?? {}).map(([name, command]) => ({
      name,
      description: command.description ?? "",
      shortcut: command.suggested_key?.mac ?? command.suggested_key?.default ?? "",
    })),
  "commands.update": () => undefined,
  "commands.reset": () => undefined,

  "management.setEnabled": () => {
    throw new Error("Extensions can't turn others on or off here.");
  },

  "runtime.openOptionsPage": (extension, _args, caller) => {
    const url = optionsUrlOf(extension.id, manifestOf(extension));
    if (url) void createTab(caller.profile, url);
  },
};

/** An event from an extension's page (any webContents) or from its worker. */
type CrxEvent = IpcMainInvokeEvent | IpcMainServiceWorkerInvokeEvent;

function callerOf(event: CrxEvent, extensionId: unknown): Caller | null {
  if (typeof extensionId !== "string") return null;
  const own = `chrome-extension://${extensionId}/`;
  if (event.type === "service-worker") {
    const profile = profiles.get(event.session);
    return profile && event.serviceWorker.scope.startsWith(own) ? { profile, sender: null } : null;
  }
  const profile = profiles.get(event.sender.session);
  return profile && event.senderFrame?.url.startsWith(own)
    ? { profile, sender: event.sender }
    : null;
}

function wire(target: { handle: typeof ipcMain.handle }): void {
  target.handle(
    Channels.CRX_CALL_CHANNEL,
    async (event, extensionId: unknown, name: unknown, args: unknown) => {
      const caller = callerOf(event as CrxEvent, extensionId);
      const extension = caller?.profile.session.extensions.getExtension(extensionId as string);
      if (!caller || !extension) throw new Error("Not an extension of this browser.");
      const call = typeof name === "string" ? calls[name] : undefined;
      if (!call) throw new Error(`chrome.${String(name)} isn't available here.`);
      return call(extension, Array.isArray(args) ? args : [], caller);
    },
  );
  target.handle(Channels.CRX_LISTEN_CHANNEL, (event, extensionId: unknown, name: unknown) => {
    const caller = callerOf(event as CrxEvent, extensionId);
    if (!caller || typeof name !== "string") return;
    onListen(caller.profile, extensionId as string, name, caller.sender ?? undefined);
  });
}

// ── Installing, turning off, on, and away ────────────────────────────

const extensionsDir = () => NodePath.join(app.getPath("userData"), "Extensions");
/** Turned-off extensions wait here, where the Web Store's loader doesn't look. */
const disabledDir = () => NodePath.join(app.getPath("userData"), "Disabled Extensions");

/** The folder holding an extension's manifest.json under `root/<id>/` (its version's). */
function installedVersion(root: string, id: string): string | null {
  const dir = NodePath.join(root, id);
  try {
    for (const entry of NodeFS.readdirSync(dir).toSorted().toReversed()) {
      const candidate = NodePath.join(dir, entry);
      if (NodeFS.existsSync(NodePath.join(candidate, "manifest.json"))) return candidate;
    }
  } catch {
    // not there
  }
  return null;
}

/** What an extension may touch, in a sentence (Chrome lists its permissions when adding one). */
function reachOf(manifest: Manifest): string {
  const hosts = [
    ...(manifest.host_permissions ?? []),
    ...(manifest.content_scripts ?? []).flatMap((script) => script.matches ?? []),
  ];
  if (hosts.some((host) => host === "<all_urls>" || /^\*:\/\/\*\/|^https?:\/\/\*\//.test(host))) {
    return "It can read and change what's on every site you visit in the browser.";
  }
  const names = [...new Set(hosts.map((host) => host.replace(/^[^:]+:\/\/|\/.*$/g, "")))];
  return names.length > 0
    ? `It can read and change what's on ${names.slice(0, 3).join(", ")}${names.length > 3 ? " and other sites" : ""}.`
    : "It doesn't ask to read the sites you visit.";
}

function optionsUrlOf(id: string, manifest: Manifest): string | null {
  const page = manifest.options_ui?.page ?? manifest.options_page;
  return page ? absolute(id, page) : null;
}

function readInstalled(root: string, enabled: boolean): DesktopPreviewExtension[] {
  let ids: string[] = [];
  try {
    ids = NodeFS.readdirSync(root);
  } catch {
    return [];
  }
  return ids.flatMap((id) => {
    const dir = installedVersion(root, id);
    if (!dir) return [];
    try {
      const manifest = JSON.parse(
        NodeFS.readFileSync(NodePath.join(dir, "manifest.json"), "utf8"),
      ) as Manifest;
      const icon = iconDataUrl(dir, iconFile(manifest.icons, 64));
      return [
        {
          id,
          name: localized(dir, manifest, manifest.name) ?? id,
          version: manifest.version ?? "",
          description: localized(dir, manifest, manifest.description) ?? "",
          icon,
          hasOptions: enabled && optionsUrlOf(id, manifest) !== null,
          enabled,
          siteAccess: reachOf(manifest),
          permissions: manifest.permissions ?? [],
        },
      ];
    } catch {
      return [];
    }
  });
}

/** Every installed extension, on or off. */
function listExtensions(): DesktopPreviewExtension[] {
  return [...readInstalled(extensionsDir(), true), ...readInstalled(disabledDir(), false)].toSorted(
    (a, b) => a.name.localeCompare(b.name),
  );
}

function forget(extensionId: string): void {
  actions.delete(extensionId);
  menus.delete(extensionId);
  for (const profile of profiles.values()) {
    profile.listening.delete(extensionId);
    profile.pages.delete(extensionId);
  }
}

async function setExtensionEnabled(id: string, enabled: boolean): Promise<void> {
  if (!enabled) {
    forget(id);
    for (const profile of profiles.values()) {
      if (profile.session.extensions.getExtension(id))
        profile.session.extensions.removeExtension(id);
    }
    if (!NodeFS.existsSync(NodePath.join(extensionsDir(), id))) return;
    NodeFS.mkdirSync(disabledDir(), { recursive: true });
    NodeFS.rmSync(NodePath.join(disabledDir(), id), { recursive: true, force: true });
    NodeFS.renameSync(NodePath.join(extensionsDir(), id), NodePath.join(disabledDir(), id));
  } else {
    if (NodeFS.existsSync(NodePath.join(disabledDir(), id))) {
      NodeFS.mkdirSync(extensionsDir(), { recursive: true });
      NodeFS.renameSync(NodePath.join(disabledDir(), id), NodePath.join(extensionsDir(), id));
    }
    const dir = installedVersion(extensionsDir(), id);
    if (!dir) throw new Error("The extension's files are missing.");
    // Loading it in one profile loads it in the rest (`share`).
    const profile = firstProfile();
    if (profile && !profile.session.extensions.getExtension(id)) {
      await profile.session.extensions.loadExtension(dir);
    }
  }
  notifyChanged();
}

async function removeExtension(id: string): Promise<void> {
  forget(id);
  for (const profile of profiles.values()) {
    if (profile.session.extensions.getExtension(id)) profile.session.extensions.removeExtension(id);
  }
  await NodeFS.promises.rm(NodePath.join(extensionsDir(), id), { recursive: true, force: true });
  await NodeFS.promises.rm(NodePath.join(disabledDir(), id), { recursive: true, force: true });
  notifyChanged();
}

/** Developer mode: an unpacked extension from a folder, copied in beside the Web Store's. */
async function loadUnpacked(owner: BrowserWindow | null): Promise<DesktopPreviewExtension | null> {
  const profile = firstProfile();
  if (!profile) throw new Error("Open a browser tab first.");
  const options = {
    title: "Load an unpacked extension",
    buttonLabel: "Select",
    properties: ["openDirectory"] as "openDirectory"[],
  };
  const { canceled, filePaths } = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  const dir = filePaths[0];
  if (canceled || !dir) return null;
  if (!NodeFS.existsSync(NodePath.join(dir, "manifest.json"))) {
    throw new Error("That folder has no manifest.json.");
  }
  const extensions = profile.session.extensions;
  const extension = await extensions.loadExtension(dir, { allowFileAccess: true });
  const target = NodePath.join(extensionsDir(), extension.id, extension.version || "0");
  if (NodePath.resolve(dir) !== NodePath.resolve(target)) {
    extensions.removeExtension(extension.id);
    NodeFS.rmSync(NodePath.join(extensionsDir(), extension.id), { recursive: true, force: true });
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.cpSync(dir, target, { recursive: true });
    await extensions.loadExtension(target, { allowFileAccess: true });
  }
  notifyChanged();
  return listExtensions().find((each) => each.id === extension.id) ?? null;
}

type InstallRequest = Parameters<
  NonNullable<NonNullable<Parameters<typeof installChromeWebStore>[0]>["beforeInstall"]>
>[0];

/** The Web Store's "Add to Chrome": asks before anything is installed. */
async function confirmInstall(details: InstallRequest): Promise<{ action: "allow" | "deny" }> {
  const window = details.browserWindow ?? BrowserWindow.getFocusedWindow();
  const options = {
    message: `Add “${details.localizedName}”?`,
    detail: reachOf(details.manifest as Manifest),
    ...(details.icon.isEmpty() ? {} : { icon: details.icon }),
    buttons: ["Add Extension", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return { action: response === 0 ? "allow" : "deny" };
}

/**
 * An extension loaded in one profile loads in every other: one installed from
 * the Web Store, updated, or turned on.
 */
async function share(from: Profile, extension: Extension): Promise<void> {
  for (const profile of profiles.values()) {
    if (profile === from) continue;
    const extensions = profile.session.extensions;
    const loaded = extensions.getExtension(extension.id);
    if (loaded?.path === extension.path) continue;
    try {
      if (loaded) extensions.removeExtension(extension.id);
      await extensions.loadExtension(extension.path);
    } catch (error) {
      console.warn("Couldn't load an extension in another browser profile", {
        extensionId: extension.id,
        error: String(error),
      });
    }
  }
}

// ── Setup ────────────────────────────────────────────────────────────

let preloadPath = "";
let nativeDirectories: string[] = [];

/** The preview's toolbar and Settings: what the renderer asks for, and new tabs to track. */
export function installPreviewExtensions(options: {
  readonly preloadPath: string;
  readonly nativeMessagingDirectories: string[];
}): void {
  if (preloadPath) return;
  preloadPath = options.preloadPath;
  nativeDirectories = options.nativeMessagingDirectories;
  wire(ipcMain);

  // The app's renderer only: never a preview page or an extension's.
  const fromApp = (event: IpcMainInvokeEvent) => {
    if (event.sender.getType() !== "window" || profiles.has(event.sender.session)) return false;
    if (!appRenderers.has(event.sender)) {
      appRenderers.add(event.sender);
      event.sender.once("destroyed", () => appRenderers.delete(event.sender));
    }
    return true;
  };
  const owner = (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender);
  const handle = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
  ) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromApp(event)) throw new Error("Not the app's window.");
      return handler(event, ...args);
    });

  handle(Channels.LIST_CHANNEL, () => listExtensions());
  handle(Channels.ACTIONS_CHANNEL, (_event, webContentsId: unknown) =>
    typeof webContentsId === "number" ? extensionActions(webContentsId) : [],
  );
  handle(Channels.RUN_ACTION_CHANNEL, (event, input: unknown) => {
    const { extensionId, webContentsId, anchor } = (input ?? {}) as {
      extensionId?: unknown;
      webContentsId?: unknown;
      anchor?: DesktopPreviewExtensionAnchor;
    };
    const window = owner(event);
    if (typeof extensionId !== "string" || typeof webContentsId !== "number" || !anchor || !window)
      return;
    runAction(window, extensionId, webContentsId, anchor);
  });
  handle(Channels.SET_ACTIVE_TAB_CHANNEL, (_event, webContentsId: unknown) => {
    if (typeof webContentsId === "number") setActiveTab(webContentsId);
  });
  handle(Channels.OPEN_OPTIONS_CHANNEL, (_event, extensionId: unknown) => {
    if (typeof extensionId !== "string") return;
    for (const profile of profiles.values()) {
      const extension = profile.session.extensions.getExtension(extensionId);
      const url = extension ? optionsUrlOf(extension.id, manifestOf(extension)) : null;
      if (url) {
        openPageWindow(profile, url);
        return;
      }
    }
  });
  handle(Channels.OPEN_WEB_STORE_CHANNEL, (_event, url: unknown) => {
    const target = new URL(typeof url === "string" ? url : WEB_STORE_URL);
    if (target.origin !== "https://chromewebstore.google.com") {
      throw new Error("Expected a Chrome Web Store URL.");
    }
    const profile = firstProfile();
    if (!profile) throw new Error("Open a browser tab first.");
    openPageWindow(profile, target.href);
  });
  handle(Channels.SET_ENABLED_CHANNEL, (_event, extensionId: unknown, enabled: unknown) =>
    typeof extensionId === "string"
      ? setExtensionEnabled(extensionId, enabled === true)
      : undefined,
  );
  handle(Channels.REMOVE_CHANNEL, (_event, extensionId: unknown) =>
    typeof extensionId === "string" ? removeExtension(extensionId) : undefined,
  );
  handle(Channels.LOAD_UNPACKED_CHANNEL, (event) => loadUnpacked(owner(event)));

  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") return;
    const profile = profiles.get(contents.session);
    if (profile) trackTab(contents, profile);
  });
  const focusChanged = (windowId: number) => {
    for (const profile of profiles.values()) {
      emit(profile, () => ["windows.onFocusChanged", [windowId]]);
    }
  };
  app.on("browser-window-focus", (_event, window) => focusChanged(window.id));
  app.on("browser-window-blur", () => focusChanged(-1));
}

/**
 * Gives a persistent preview partition extensions: the Web Store's install
 * button, every installed extension, and their preload. Once per partition,
 * before its first webview attaches.
 */
export function enablePreviewExtensions(session: Session): void {
  if (!preloadPath || profiles.has(session)) return;
  enableNativeMessaging(session, nativeDirectories);
  const profile: Profile = {
    session,
    listening: new Map(),
    pages: new Map(),
    listenWaiters: new Map(),
    failedWorkers: new Map(),
    starting: new Map(),
    activeTabId: -1,
  };
  profiles.set(session, profile);
  // Before the Web Store's own preload, which this one lets work in the
  // preview's pages (see preview-extensions-preload.ts).
  for (const type of ["frame", "service-worker"] as const) {
    session.registerPreloadScript({ id: `otter-extensions-${type}`, type, filePath: preloadPath });
  }
  // A worker's calls may arrive on its own ipc rather than ipcMain.
  const wired = new WeakSet<ServiceWorkerMain>();
  session.serviceWorkers.on("running-status-changed", ({ versionId, runningStatus }) => {
    if (runningStatus !== "starting" && runningStatus !== "running") return;
    const worker = session.serviceWorkers.getWorkerFromVersionID(versionId);
    if (!worker || wired.has(worker) || !worker.scope.startsWith("chrome-extension://")) return;
    wired.add(worker);
    wire(worker.ipc as unknown as { handle: typeof ipcMain.handle });
  });
  session.extensions.on("extension-loaded", (_event, extension) => {
    void share(profile, extension);
    notifyChanged();
  });
  session.extensions.on("extension-unloaded", () => notifyChanged());
  for (const contents of allWebContents.getAllWebContents()) {
    if (contents.session === session && contents.getType() === "webview") {
      trackTab(contents, profile);
    }
  }
  // One profile checks for updates; `share` hands them to the rest.
  const checksForUpdates = profiles.size === 1;
  // Loaded here, not at the top: the library reaches into Electron as it loads.
  void import("electron-chrome-web-store")
    .then((webStore) =>
      webStore.installChromeWebStore({
        session,
        extensionsPath: extensionsDir(),
        beforeInstall: confirmInstall,
        autoUpdate: checksForUpdates,
      }),
    )
    .catch((error: unknown) =>
      console.error("Chrome Web Store setup failed", { error: String(error) }),
    );
}
