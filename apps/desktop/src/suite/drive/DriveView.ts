/** Persistent Drive WebContentsView. The renderer owns only its placement and navigation. */
import type { DriveDesktopState } from "@t3tools/contracts/suite";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BrowserWindow, ipcMain, shell, WebContentsView } from "electron";
import { DRIVE_COMMAND, DRIVE_STATE } from "./channels.ts";
import { driveViewBounds, isDriveViewUrl } from "./navigation.ts";

const Request = Schema.Union([
  Schema.Struct({ action: Schema.Literal("open"), url: Schema.String, baseUrl: Schema.String }),
  Schema.Struct({
    action: Schema.Literal("bounds"),
    bounds: Schema.NullOr(
      Schema.Struct({
        x: Schema.Number,
        y: Schema.Number,
        width: Schema.Number,
        height: Schema.Number,
      }),
    ),
  }),
  Schema.Struct({ action: Schema.Literals(["back", "forward", "reload"]) }),
]);
const decode = Schema.decodeUnknownSync(Request);

export const installDriveView = Effect.acquireRelease(
  Effect.sync(() => {
    const views = new Map<
      number,
      {
        view: WebContentsView;
        window: BrowserWindow;
        baseUrl: string;
        failed: string | null;
        visible: boolean;
      }
    >();
    ipcMain.handle(DRIVE_COMMAND, (event, raw: unknown) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.webContents !== event.sender)
        throw new Error("Drive IPC requires the app window.");
      const request = decode(raw);
      let entry = views.get(event.sender.id);
      if (request.action === "open") {
        if (!isDriveViewUrl(request.url, request.baseUrl))
          throw new Error("That is not a Drive URL.");
        if (!entry) {
          const view = new WebContentsView({
            webPreferences: {
              partition: "persist:otterware-drive",
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              webSecurity: true,
            },
          });
          view.setVisible(false);
          window.contentView.addChildView(view);
          entry = { view, window, baseUrl: request.baseUrl, failed: null, visible: false };
          views.set(event.sender.id, entry);
          const owned = entry;
          const wc = view.webContents;
          const publish = () => {
            if (!wc.isDestroyed()) view.setVisible(owned.visible && !owned.failed);
            if (!event.sender.isDestroyed() && !wc.isDestroyed())
              event.sender.send(DRIVE_STATE, stateOf(owned));
          };
          const guard = (navigationEvent: Electron.Event, url: string) => {
            if (isDriveViewUrl(url, owned.baseUrl)) return;
            navigationEvent.preventDefault();
            openExternal(url);
          };
          wc.on("will-navigate", guard);
          wc.on("will-redirect", guard);
          wc.setWindowOpenHandler(({ url }) => {
            if (isDriveViewUrl(url, owned.baseUrl)) void wc.loadURL(url).catch(() => undefined);
            else openExternal(url);
            return { action: "deny" };
          });
          wc.on("did-start-loading", () => {
            owned.failed = null;
            publish();
          });
          wc.on("did-stop-loading", publish);
          wc.on("did-navigate", publish);
          wc.on("did-navigate-in-page", publish);
          wc.on("page-title-updated", publish);
          wc.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
            if (!mainFrame || code === -3) return;
            owned.failed = description;
            view.setVisible(false);
            publish();
          });
          event.sender.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
            if (mainFrame) {
              owned.visible = false;
              view.setVisible(false);
            }
          });
          event.sender.once("destroyed", () => {
            views.delete(event.sender.id);
            if (!wc.isDestroyed()) wc.close();
          });
        }
        entry.baseUrl = request.baseUrl;
        void entry.view.webContents.loadURL(request.url).catch(() => undefined);
        return stateOf(entry);
      }
      if (!entry) return;
      const wc = entry.view.webContents;
      if (request.action === "bounds") {
        const bounds =
          request.bounds && driveViewBounds(request.bounds, event.sender.getZoomFactor());
        if (bounds) entry.view.setBounds(bounds);
        entry.visible = bounds !== null;
        entry.view.setVisible(entry.visible && !entry.failed);
      } else if (request.action === "back" && wc.navigationHistory.canGoBack())
        wc.navigationHistory.goBack();
      else if (request.action === "forward" && wc.navigationHistory.canGoForward())
        wc.navigationHistory.goForward();
      else if (request.action === "reload") wc.reload();
    });
    return views;
  }),
  (views) =>
    Effect.sync(() => {
      ipcMain.removeHandler(DRIVE_COMMAND);
      for (const { view, window } of views.values()) {
        if (!window.isDestroyed()) window.contentView.removeChildView(view);
        if (!view.webContents.isDestroyed()) view.webContents.close();
      }
    }),
);

function stateOf(entry: { view: WebContentsView; failed: string | null }): DriveDesktopState {
  const wc = entry.view.webContents;
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    failed: entry.failed,
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
  };
}

function openExternal(url: string) {
  try {
    if (["https:", "http:", "mailto:"].includes(new URL(url).protocol))
      void shell.openExternal(url).catch(() => undefined);
  } catch {
    /* A malformed link is ignored. */
  }
}
