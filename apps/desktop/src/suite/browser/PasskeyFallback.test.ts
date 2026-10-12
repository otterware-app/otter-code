import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
  dialog: vi.fn(),
  openExternal: vi.fn(),
  fromWebContents: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  dialog: { showMessageBox: mocks.dialog },
  shell: { openExternal: mocks.openExternal },
}));
import {
  attachPasskeyFallback,
  offerPasskeyFallback,
  passkeyFallbackUrl,
  PASSKEY_FALLBACK_CHANNEL,
} from "./PasskeyFallback.ts";
import { installPasskeyFallbackBridge } from "./PasskeyFallbackBridge.ts";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fromWebContents.mockReturnValue(null);
  mocks.dialog.mockResolvedValue({ response: 1 });
});
afterEach(() => vi.unstubAllGlobals());

describe("passkey browser handoff", () => {
  it("uses the committed page URL and a validated relying party for extension pages", () => {
    expect(passkeyFallbackUrl("https://example.com/login?next=home", "other.com")).toBe(
      "https://example.com/login?next=home",
    );
    expect(passkeyFallbackUrl("http://localhost:3000/login", undefined)).toBe(
      "http://localhost:3000/login",
    );
    expect(passkeyFallbackUrl("chrome-extension://id/popup.html", "bitwarden.com")).toBe(
      "https://vault.bitwarden.com/#/login",
    );
    expect(passkeyFallbackUrl("chrome-extension://id/popup.html", "bitwarden.eu")).toBe(
      "https://vault.bitwarden.eu/#/login",
    );
    expect(passkeyFallbackUrl("chrome-extension://id/popup.html", "accounts.example.com")).toBe(
      "https://accounts.example.com/",
    );
    for (const rp of [
      "com",
      "github.io",
      "javascript:alert(1)",
      "evil.com/path",
      "example.com@evil.com",
      undefined,
    ])
      expect(passkeyFallbackUrl("chrome-extension://id/popup.html", rp)).toBeNull();
    for (const url of [
      "file:///tmp/secret",
      "javascript:alert(1)",
      "http://192.168.1.2/",
      "invalid",
    ])
      expect(passkeyFallbackUrl(url, "example.com")).toBeNull();
  });
  it("asks before opening, ignores background/subframe requests and attaches once", async () => {
    const frame = { url: "https://example.com/login" };
    const handle = vi.fn();
    const contents = {
      mainFrame: frame,
      isDestroyed: () => false,
      isFocused: () => true,
      ipc: { handle },
    } as unknown as Electron.WebContents;
    attachPasskeyFallback(contents);
    attachPasskeyFallback(contents);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]?.[0]).toBe(PASSKEY_FALLBACK_CHANNEL);
    const invoke = handle.mock.calls[0]![1];
    await invoke({ senderFrame: {} }, "example.com");
    expect(mocks.dialog).not.toHaveBeenCalled();
    await invoke({ senderFrame: frame }, "example.com");
    expect(mocks.openExternal).not.toHaveBeenCalled();
    mocks.dialog.mockResolvedValue({ response: 0 });
    await offerPasskeyFallback(contents);
    expect(mocks.openExternal).toHaveBeenCalledWith("https://example.com/login");
    await offerPasskeyFallback({ ...contents, isFocused: () => false } as Electron.WebContents);
    expect(mocks.openExternal).toHaveBeenCalledTimes(1);
  });
  it("coalesces repeated failures while the handoff dialog is open", async () => {
    let finish!: (value: { response: number }) => void;
    mocks.dialog.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const contents = {
      mainFrame: { url: "https://example.com" },
      isDestroyed: () => false,
      isFocused: () => true,
    } as unknown as Electron.WebContents;
    const first = offerPasskeyFallback(contents);
    await offerPasskeyFallback(contents);
    expect(mocks.dialog).toHaveBeenCalledTimes(1);
    finish({ response: 1 });
    await first;
  });
  it("observes failed get/create ceremonies while preserving the original result or exception", async () => {
    const failure = new DOMException("Unavailable", "NotAllowedError");
    class Credentials {
      async get() {
        throw failure;
      }
      async create() {
        throw failure;
      }
    }
    vi.stubGlobal("CredentialsContainer", Credentials);
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    const notify = vi.fn();
    installPasskeyFallbackBridge(notify);
    const credentials = new Credentials() as unknown as CredentialsContainer;
    await expect(
      credentials.get({ publicKey: { challenge: new Uint8Array([1]), rpId: "example.com" } }),
    ).rejects.toBe(failure);
    await expect(
      credentials.create({
        publicKey: {
          challenge: new Uint8Array([1]),
          rp: { id: "example.com", name: "Example" },
          user: { id: new Uint8Array([1]), name: "a", displayName: "a" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        },
      }),
    ).rejects.toBe(failure);
    expect(notify.mock.calls).toEqual([["example.com"], ["example.com"]]);
    await expect(
      credentials.get({ mediation: "conditional", publicKey: { challenge: new Uint8Array([1]) } }),
    ).rejects.toBe(failure);
    await expect(credentials.get({})).rejects.toBe(failure);
    const signal = AbortSignal.abort();
    await expect(
      credentials.get({ signal, publicKey: { challenge: new Uint8Array([1]) } }),
    ).rejects.toBe(failure);
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it("keeps successful credentials and unsupported contexts unchanged", async () => {
    const credential = { id: "passkey" };
    class Credentials {
      async get() {
        return credential;
      }
      async create() {
        return credential;
      }
    }
    vi.stubGlobal("CredentialsContainer", Credentials);
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    const notify = vi.fn();
    installPasskeyFallbackBridge(notify);
    expect(await new Credentials().get()).toBe(credential);
    expect(notify).not.toHaveBeenCalled();
    vi.stubGlobal("CredentialsContainer", undefined);
    expect(() => installPasskeyFallbackBridge(notify)).not.toThrow();
  });
});
