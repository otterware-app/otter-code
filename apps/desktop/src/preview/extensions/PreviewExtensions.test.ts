// @effect-diagnostics nodeBuiltinImport:off -- Tests the Electron extension IPC boundary.
import * as NodeEvents from "node:events";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import { OPEN_WEB_STORE_CHANNEL } from "./channels.ts";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  loadURL: vi.fn(),
  windows: vi.fn(),
  enableNativeMessaging: vi.fn(),
  installChromeWebStore: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { on: vi.fn(), getPath: () => "/test-user-data" },
  ipcMain: { handle: mocks.handle },
  webContents: { getAllWebContents: () => [] },
  nativeTheme: { shouldUseDarkColors: false },
  BrowserWindow: class {
    static fromWebContents() {
      return null;
    }
    readonly webContents = Object.assign(new NodeEvents.EventEmitter(), {
      id: 10,
      setWindowOpenHandler: vi.fn(),
    });
    readonly loadURL = mocks.loadURL;
    constructor(options: unknown) {
      mocks.windows(options);
    }
  },
}));

vi.mock("./NativeMessagingIPC.ts", () => ({
  enableNativeMessaging: mocks.enableNativeMessaging,
}));

vi.mock("electron-chrome-web-store", () => ({
  installChromeWebStore: mocks.installChromeWebStore,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

async function setup() {
  const { installPreviewExtensions, enablePreviewExtensions } =
    await import("./PreviewExtensions.ts");
  installPreviewExtensions({
    preloadPath: "/test-extension-preload.cjs",
    nativeMessagingDirectories: ["/test-native-hosts"],
  });
  const session = {
    registerPreloadScript: vi.fn(),
    serviceWorkers: Object.assign(new NodeEvents.EventEmitter(), {
      getWorkerFromVersionID: vi.fn(),
    }),
    extensions: Object.assign(new NodeEvents.EventEmitter(), {
      getAllExtensions: () => [],
    }),
  };
  enablePreviewExtensions(session as unknown as Parameters<typeof enablePreviewExtensions>[0]);
  const open = mocks.handle.mock.calls.find(
    ([channel]) => channel === OPEN_WEB_STORE_CHANNEL,
  )![1] as (event: unknown, url?: string) => void;
  const event = {
    sender: { getType: () => "window", session: {}, once: vi.fn() },
  };
  return { session, open: (url?: string) => open(event, url) };
}

it("opens an extension listing in the local extension-enabled session", async () => {
  const { session, open } = await setup();
  const url = "https://chromewebstore.google.com/detail/1password/aeblfdkhhhdcdjpifhhbdiojplfjncoa";
  open(url);

  expect(mocks.loadURL).toHaveBeenCalledWith(url);
  expect(mocks.windows).toHaveBeenCalledWith(
    expect.objectContaining({ webPreferences: expect.objectContaining({ session }) }),
  );
  expect(mocks.enableNativeMessaging).toHaveBeenCalledWith(session, ["/test-native-hosts"]);
});

it("keeps the default store page for callers that do not supply a listing", async () => {
  const { open } = await setup();
  open();
  expect(mocks.loadURL).toHaveBeenCalledWith(
    "https://chromewebstore.google.com/category/extensions",
  );
});

it("refuses to open other origins as an extension store", async () => {
  const { open } = await setup();
  expect(() => open("https://example.com/")).toThrow("Expected a Chrome Web Store URL.");
  expect(mocks.windows).not.toHaveBeenCalled();
});
