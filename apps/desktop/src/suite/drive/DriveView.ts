// @effect-diagnostics globalTimers:off globalTimersInEffect:off -- Electron IPC renewal deadlines and the main-process clock use native timers with explicit disposal.
/** Persistent Drive WebContentsView. The renderer owns only its placement and navigation. */
import { DRIVE_DEFAULT_BASE_URL, type DriveDesktopState } from "@t3tools/contracts/suite";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BrowserWindow, ipcMain, shell, session, WebContentsView, powerMonitor } from "electron";
import { DRIVE_COMMAND, DRIVE_SIGN_OUT, DRIVE_STATE, DRIVE_RENEW_ACCOUNT } from "./channels.ts";
import { driveViewBounds, isDriveSuiteSignOutUrl, isDriveViewUrl } from "./navigation.ts";

import { createDriveAccountRecovery } from "./accountRecovery.ts";

import { driveNavigationUrl, driveAccountChanged, driveShouldBeVisible } from "./viewDecisions.ts";

const Request = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("renewal-result"),
    id: Schema.Number,
    ok: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("account"),
    token: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    action: Schema.Literals(["show", "open"]),
    url: Schema.String,
    baseUrl: Schema.String,
  }),
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
const decodeUser = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }));

export const installDriveView = Effect.acquireRelease(
  Effect.gen(function* () {
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const trace = (message: string, attributes: Record<string, string | number | boolean> = {}) => {
      void runPromise(
        Effect.logInfo(message).pipe(Effect.withSpan("suite.drive.account", { attributes })),
      );
    };
    const driveSession = session.fromPartition("persist:otterware-drive");
    let syncingAccount = 0;
    let accountUserId: string | null | undefined = undefined;
    let accountTail: Promise<unknown> = Promise.resolve();
    let requestId = 0;
    const renewals = new Map<number, { senderId: number; finish: (ok: boolean) => void }>();
    const pendingWindows = new Set<number>();
    const requestRenewal = (window: BrowserWindow, recover: boolean): Promise<void> => {
      if (window.isDestroyed()) return Promise.reject(new Error("App window closed."));
      if (pendingWindows.has(window.webContents.id))
        return Promise.reject(new Error("Account renewal is already pending."));
      const id = ++requestId;
      pendingWindows.add(window.webContents.id);
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(false), 60_000);
        const finish = (ok: boolean) => {
          clearTimeout(timer);
          renewals.delete(id);
          pendingWindows.delete(window.webContents.id);
          if (ok) resolve();
          else reject(new Error("Suite account renewal failed."));
        };
        renewals.set(id, { senderId: window.webContents.id, finish });
        window.webContents.send(DRIVE_RENEW_ACCOUNT, recover, id);
      });
    };
    type DriveViewEntry = {
      view: WebContentsView;
      window: BrowserWindow;
      baseUrl: string;
      pendingUrl: string;
      failed: string | null;
      visible: boolean;
      needsReload: boolean;
      recovery: ReturnType<typeof createDriveAccountRecovery>;
      checking: boolean;
    };
    const views = new Map<number, DriveViewEntry>();
    const signedOut = (
      _event: Electron.Event,
      cookie: Electron.Cookie,
      cause: string,
      removed: boolean,
    ) => {
      if (
        !cookie.name.endsWith("otterdrive.session_token") ||
        cookie.domain?.replace(/^\./, "") !== "drive.otterware.app"
      )
        return;
      if (removed) trace("cookie removed", { cause, syncing: syncingAccount > 0 });
      // Expiry and server-side invalidation can also remove cookies explicitly.
      // Only the intercepted sign-out action revokes the host account.
      if (removed && !syncingAccount) {
        for (const entry of views.values()) void checkAccount(entry);
      }
    };
    const checkAccount = async (entry: DriveViewEntry) => {
      if (
        accountUserId == null ||
        syncingAccount ||
        entry.checking ||
        pendingWindows.has(entry.window.webContents.id) ||
        entry.view.webContents.isDestroyed()
      )
        return;
      entry.checking = true;
      try {
        const url = new URL(entry.view.webContents.getURL() || entry.pendingUrl);
        if (url.origin !== DRIVE_DEFAULT_BASE_URL) return;
        const welcome = url.pathname === "/login";
        const response = await driveSession.fetch(
          `${DRIVE_DEFAULT_BASE_URL}/api/auth/get-session`,
          {
            credentials: "include",
            cache: "no-store",
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!response.ok || syncingAccount) return;
        const current: unknown = await response.json();
        if (current === null || welcome) {
          entry.needsReload = true;
          await entry.recovery.recover();
        } else if (current && typeof current === "object" && "user" in current) {
          entry.recovery.healthy();
        }
      } catch {
        // A network outage is not a sign-out.
      } finally {
        entry.checking = false;
      }
    };
    const tick = (recover: boolean) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!pendingWindows.has(window.webContents.id))
          void requestRenewal(window, recover)
            .then(() => {
              for (const entry of views.values())
                if (entry.window === window && entry.visible) void checkAccount(entry);
            })
            .catch(() => undefined);
      }
    };
    // Main-process timers keep running when macOS throttles Chromium's background timers.
    // Accounts currently rotates the suite credential only in its last 60 seconds.
    const timer = setInterval(() => tick(false), 15_000);
    const wake = () => {
      // A request sent just before suspend may no longer have a live renderer listener.
      for (const pending of renewals.values()) pending.finish(false);
      tick(true);
    };
    powerMonitor.on("resume", wake);
    powerMonitor.on("unlock-screen", wake);
    driveSession.cookies.on("changed", signedOut);
    ipcMain.handle(DRIVE_COMMAND, async (event, raw: unknown) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.webContents !== event.sender)
        throw new Error("Drive IPC requires the app window.");
      const request = decode(raw);
      if (request.action === "renewal-result") {
        const pending = renewals.get(request.id);
        if (pending?.senderId === event.sender.id) pending.finish(request.ok);
        return;
      }
      if (request.action === "account") {
        if (request.token === undefined) return;
        // Serialize refresh and sign-out so a slow exchange cannot restore a revoked session.
        const token = request.token;
        const apply = async () => {
          syncingAccount += 1;
          trace("sync started", { signingOut: token === null });
          let stage = "restore-session";
          let status = 0;
          try {
            let nextUserId: string | null = null;
            if (accountUserId === undefined && token !== null) {
              // Recover the persisted browser identity without changing its cookies.
              const response = await driveSession
                .fetch(`${DRIVE_DEFAULT_BASE_URL}/api/auth/get-session`, {
                  signal: AbortSignal.timeout(10_000),
                  credentials: "include",
                })
                .catch(() => null);
              if (response?.ok) {
                const existing: unknown = await response.json();
                if (existing && typeof existing === "object" && "user" in existing)
                  accountUserId = decodeUser(existing.user).id;
                else accountUserId = null;
              }
            }
            // Renew in place so an open document keeps its editing state.
            if (token === null) {
              stage = "clear-cookies";
              const cookies = await driveSession.cookies.get({ url: DRIVE_DEFAULT_BASE_URL });
              await Promise.all(
                cookies.map((cookie) =>
                  driveSession.cookies.remove(DRIVE_DEFAULT_BASE_URL, cookie.name),
                ),
              );
            }
            if (token !== null) {
              stage = "exchange";
              const response = await driveSession.fetch(
                `${DRIVE_DEFAULT_BASE_URL}/api/auth/suite-session`,
                {
                  method: "POST",
                  headers: {
                    authorization: `Bearer ${token}`,
                    "content-type": "application/json",
                  },
                  body: "{}",
                  redirect: "error",
                  credentials: "include",
                  signal: AbortSignal.timeout(20_000),
                },
              );
              status = response.status;
              if (!response.ok) throw new Error("Drive could not sign in with your Otter account.");
              const result: unknown = await response.json();
              if (!result || typeof result !== "object" || !("user" in result))
                throw new Error("Drive returned an invalid account.");
              nextUserId = decodeUser(result.user).id;
              stage = "verify-cookie";
              // Electron's network stack saves the service's HttpOnly session cookie.
              const cookies = await driveSession.cookies.get({ url: DRIVE_DEFAULT_BASE_URL });
              if (
                !cookies.some(
                  (cookie) => cookie.httpOnly && cookie.name.endsWith("otterdrive.session_token"),
                )
              )
                throw new Error("Drive did not establish its browser session.");
            }
            for (const entry of views.values()) {
              if (
                token === null ||
                driveAccountChanged(accountUserId, nextUserId) ||
                entry.needsReload
              ) {
                entry.needsReload = false;
                if (!entry.view.webContents.isDestroyed()) entry.view.webContents.reload();
              }
            }
            accountUserId = nextUserId;
            trace("sync ok", { signingOut: token === null });
          } catch (error) {
            trace("sync failed", { signingOut: token === null, stage, status });
            throw error;
          } finally {
            syncingAccount -= 1;
          }
        };
        const pending = accountTail.catch(() => undefined).then(apply);
        accountTail = pending;
        return pending;
      }
      let entry = views.get(event.sender.id);
      if (request.action === "show" || request.action === "open") {
        const currentUrl = entry ? entry.view.webContents.getURL() || entry.pendingUrl : null;
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
          entry = {
            view,
            window,
            baseUrl: request.baseUrl,
            pendingUrl: request.url,
            failed: null,
            visible: false,
            needsReload: false,
            checking: false,
            recovery: createDriveAccountRecovery({
              renew: () => requestRenewal(window, true),
              reload: () => {
                if (owned.needsReload && !wc.isDestroyed()) {
                  owned.needsReload = false;
                  wc.reload();
                }
              },
              trace,
            }),
          };
          views.set(event.sender.id, entry);
          const owned = entry;
          const wc = view.webContents;
          const publish = () => {
            if (!wc.isDestroyed()) view.setVisible(owned.visible && owned.failed === null);
            if (!event.sender.isDestroyed() && !wc.isDestroyed())
              event.sender.send(DRIVE_STATE, stateOf(owned));
          };
          const guard = (navigationEvent: Electron.Event, url: string) => {
            if (accountUserId != null && isDriveSuiteSignOutUrl(url)) {
              navigationEvent.preventDefault();
              if (!window.isDestroyed()) window.webContents.send(DRIVE_SIGN_OUT);
              return;
            }
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
          wc.on("did-stop-loading", () => {
            publish();
            void checkAccount(owned);
          });
          wc.on("did-navigate", publish);
          wc.on("did-navigate-in-page", () => {
            publish();
            void checkAccount(owned);
          });
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
        window.contentView.addChildView(entry.view);
        entry.baseUrl = request.baseUrl;
        const target = driveNavigationUrl(request.action, request.url, currentUrl);
        if (target) {
          entry.pendingUrl = target;
          void entry.view.webContents.loadURL(target).catch(() => undefined);
        }
        return stateOf(entry);
      }
      if (!entry) return;
      const wc = entry.view.webContents;
      if (request.action === "bounds") {
        const bounds =
          request.bounds && driveViewBounds(request.bounds, event.sender.getZoomFactor());
        if (bounds) entry.view.setBounds(bounds);
        entry.visible = bounds !== null;
        entry.view.setVisible(driveShouldBeVisible(bounds, entry.failed));
      } else if (request.action === "back" && wc.navigationHistory.canGoBack())
        wc.navigationHistory.goBack();
      else if (request.action === "forward" && wc.navigationHistory.canGoForward())
        wc.navigationHistory.goForward();
      else if (request.action === "reload") wc.reload();
    });
    return {
      views,
      dispose: () => {
        clearInterval(timer);
        powerMonitor.removeListener("resume", wake);
        powerMonitor.removeListener("unlock-screen", wake);
        for (const pending of renewals.values()) pending.finish(false);
        driveSession.cookies.removeListener("changed", signedOut);
      },
    };
  }),
  ({ views, dispose }) =>
    Effect.sync(() => {
      dispose();
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
