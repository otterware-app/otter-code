import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { DRIVE_DEFAULT_BASE_URL } from "@t3tools/contracts/suite";

const mocks = vi.hoisted(() => {
  const sender = {
    id: 1,
    on: vi.fn(),
    once: vi.fn(),
    send: vi.fn(),
    isDestroyed: () => false,
    getZoomFactor: () => 1,
  };
  const window = {
    webContents: sender,
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  };
  const cookies = { on: vi.fn(), removeListener: vi.fn(), get: vi.fn(), remove: vi.fn() };
  const fetch = vi.fn();
  const views: Array<{
    setVisible: ReturnType<typeof vi.fn>;
    setBounds: ReturnType<typeof vi.fn>;
    webContents: {
      loadURL: ReturnType<typeof vi.fn>;
      reload: ReturnType<typeof vi.fn>;
      getURL: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
    };
  }> = [];
  const handle = vi.fn();
  const power = { on: vi.fn(), removeListener: vi.fn() };
  return { sender, window, cookies, fetch, views, handle, power };
});
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => mocks.window, getAllWindows: () => [mocks.window] },
  powerMonitor: mocks.power,
  ipcMain: { handle: mocks.handle, removeHandler: vi.fn() },
  shell: { openExternal: vi.fn() },
  session: { fromPartition: () => ({ cookies: mocks.cookies, fetch: mocks.fetch }) },
  WebContentsView: class {
    setVisible = vi.fn();
    setBounds = vi.fn();
    webContents = {
      getURL: vi.fn(() => ""),
      getTitle: () => "",
      isLoading: () => true,
      isDestroyed: () => false,
      loadURL: vi.fn(async () => {}),
      reload: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    };
    constructor() {
      mocks.views.push(this);
    }
  },
}));
import { installDriveView } from "./DriveView.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.views.length = 0;
  mocks.cookies.get.mockResolvedValue([
    { name: "__Secure-otterdrive.session_token", httpOnly: true },
  ]);
  mocks.cookies.remove.mockResolvedValue(undefined);
  mocks.fetch.mockImplementation(async () => Response.json({ user: { id: "a" } }));
});
afterEach(() => vi.useRealTimers());
function withView(check: (command: (request: unknown) => Promise<unknown>) => Promise<void>) {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* installDriveView;
      const handler = mocks.handle.mock.calls[0]![1];
      yield* Effect.promise(() => check((request) => handler({ sender: mocks.sender }, request)));
    }),
  );
}

it.effect(
  "re-attaches a live/loading view without loadURL on show, and hides/restores with bounds",
  () => {
    return withView(async (command) => {
      const url = `${DRIVE_DEFAULT_BASE_URL}/home`;
      await command({ action: "show", url, baseUrl: DRIVE_DEFAULT_BASE_URL });
      await command({ action: "show", url, baseUrl: DRIVE_DEFAULT_BASE_URL });
      const view = mocks.views[0]!;
      expect(mocks.views).toHaveLength(1);
      expect(view.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(url);
      expect(mocks.window.contentView.addChildView).toHaveBeenCalledTimes(2);
      await command({ action: "bounds", bounds: { x: 30, y: 60, width: 800, height: 500 } });
      expect(view.setVisible).toHaveBeenLastCalledWith(true);
      await command({ action: "bounds", bounds: null });
      expect(view.setVisible).toHaveBeenLastCalledWith(false);
      await command({ action: "bounds", bounds: { x: 30, y: 60, width: 800, height: 500 } });
      expect(view.setVisible).toHaveBeenLastCalledWith(true);
      await command({
        action: "open",
        url: `${DRIVE_DEFAULT_BASE_URL}/document`,
        baseUrl: DRIVE_DEFAULT_BASE_URL,
      });
      expect(view.webContents.loadURL).toHaveBeenCalledTimes(2);
    });
  },
);
it.effect(
  "ignores unknown auth, preserves persisted same-user cookies/editing, and clears on explicit sign-out",
  () => {
    return withView(async (command) => {
      await command({
        action: "show",
        url: `${DRIVE_DEFAULT_BASE_URL}/home`,
        baseUrl: DRIVE_DEFAULT_BASE_URL,
      });
      const view = mocks.views[0]!;
      await command({ action: "account" });
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.cookies.remove).not.toHaveBeenCalled();
      await command({ action: "account", token: "same-user" });
      expect(view.webContents.reload).not.toHaveBeenCalled();
      expect(mocks.cookies.remove).not.toHaveBeenCalled();
      await command({ action: "account", token: "refresh" });
      expect(view.webContents.reload).not.toHaveBeenCalled();
      mocks.fetch.mockResolvedValue(Response.json({ user: { id: "b" } }));
      await command({ action: "account", token: "switched-user" });
      expect(view.webContents.reload).toHaveBeenCalledTimes(1);
      await command({ action: "account", token: null });
      expect(mocks.cookies.remove).toHaveBeenCalledExactlyOnceWith(
        DRIVE_DEFAULT_BASE_URL,
        "__Secure-otterdrive.session_token",
      );
      expect(view.webContents.reload).toHaveBeenCalledTimes(2);
    });
  },
);

it.effect(
  "main renews in the background, on resume and on unlock, and removes its clock on disposal",
  () => {
    return withView(async (command) => {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(mocks.sender.send).toHaveBeenCalledWith("otterware:drive:renew-account", false, 1);
      await command({ action: "renewal-result", id: 1, ok: true });
      const resume = mocks.power.on.mock.calls.find(([name]) => name === "resume")![1];
      resume();
      expect(mocks.sender.send).toHaveBeenLastCalledWith("otterware:drive:renew-account", true, 2);
      await command({ action: "renewal-result", id: 2, ok: true });
      const unlock = mocks.power.on.mock.calls.find(([name]) => name === "unlock-screen")![1];
      unlock();
      expect(mocks.sender.send).toHaveBeenLastCalledWith("otterware:drive:renew-account", true, 3);
      await command({ action: "renewal-result", id: 3, ok: true });
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(vi.getTimerCount()).toBe(0);
          expect(mocks.power.removeListener).toHaveBeenCalledTimes(2);
        }),
      ),
    );
  },
);

it.effect(
  "recovers a signed-out SPA after a same-user cookie renewal and stops after failure",
  () => {
    return withView(async (command) => {
      await command({
        action: "show",
        url: `${DRIVE_DEFAULT_BASE_URL}/home`,
        baseUrl: DRIVE_DEFAULT_BASE_URL,
      });
      await command({ action: "account", token: "first" });
      const view = mocks.views[0]!;
      view.webContents.getURL.mockReturnValue(`${DRIVE_DEFAULT_BASE_URL}/home`);
      mocks.fetch.mockImplementation(async (url) =>
        String(url).endsWith("get-session")
          ? Response.json(null)
          : Response.json({ user: { id: "a" } }),
      );
      const loaded = view.webContents.on.mock.calls.find(
        ([event]) => event === "did-stop-loading",
      )![1];
      const sent = Promise.withResolvers<number>();
      mocks.sender.send.mockImplementation((channel, _recover, id) => {
        if (channel === "otterware:drive:renew-account") sent.resolve(id);
      });
      loaded();
      const id = await sent.promise;
      await command({ action: "account", token: "first" });
      await command({ action: "renewal-result", id, ok: true });
      expect(view.webContents.reload).toHaveBeenCalledTimes(1);
      loaded();
      await vi.advanceTimersByTimeAsync(1);
      expect(
        mocks.sender.send.mock.calls.filter(
          ([channel]) => channel === "otterware:drive:renew-account",
        ),
      ).toHaveLength(1);
      // A fresh recovery episode that fails never reloads or clears cookies.
      view.webContents.getURL.mockReturnValue(`${DRIVE_DEFAULT_BASE_URL}/home`);
      mocks.fetch.mockImplementation(async () => Response.json({ user: { id: "a" } }));
      loaded();
      await vi.advanceTimersByTimeAsync(1);
      view.webContents.getURL.mockReturnValue(`${DRIVE_DEFAULT_BASE_URL}/login`);
      const next = Promise.withResolvers<number>();
      mocks.sender.send.mockImplementation((channel, _recover, id) => {
        if (channel === "otterware:drive:renew-account") next.resolve(id);
      });
      loaded();
      const failedId = await next.promise;
      await command({ action: "renewal-result", id: failedId, ok: false });
      await vi.advanceTimersByTimeAsync(1);
      loaded();
      await vi.advanceTimersByTimeAsync(1);
      expect(view.webContents.reload).toHaveBeenCalledTimes(1);
      expect(mocks.cookies.remove).not.toHaveBeenCalled();
    });
  },
);

it.effect("cookie expiry and transient Drive failures never sign out the host account", () => {
  return withView(async (command) => {
    await command({
      action: "show",
      url: `${DRIVE_DEFAULT_BASE_URL}/home`,
      baseUrl: DRIVE_DEFAULT_BASE_URL,
    });
    await command({ action: "account", token: "first" });
    mocks.views[0]!.webContents.getURL.mockReturnValue(`${DRIVE_DEFAULT_BASE_URL}/home`);
    mocks.fetch.mockImplementation(async () => new Response(null, { status: 503 }));
    const changed = mocks.cookies.on.mock.calls[0]![1];
    changed(
      {},
      { name: "__Secure-otterdrive.session_token", domain: "drive.otterware.app" },
      "explicit",
      true,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.sender.send).not.toHaveBeenCalledWith("otterware:drive:sign-out");
    expect(mocks.cookies.remove).not.toHaveBeenCalled();
    await expect(command({ action: "account", token: "refresh" })).rejects.toThrow();
    expect(mocks.cookies.remove).not.toHaveBeenCalled();
    expect(mocks.views[0]!.webContents.reload).not.toHaveBeenCalled();
  });
});
