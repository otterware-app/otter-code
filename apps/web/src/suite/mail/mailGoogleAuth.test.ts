import { describe, expect, it, vi } from "vite-plus/test";
import { receiveMailGoogleAuth, type MailGoogleAuthPrompt } from "./mailGoogleAuth";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const redirectUri = "http://127.0.0.1:42813";
const state = "m".repeat(22);
const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
url.search = new URLSearchParams({
  client_id: "1234-test.apps.googleusercontent.com",
  redirect_uri: redirectUri,
  response_type: "code",
  state,
  code_challenge: "c".repeat(43),
  code_challenge_method: "S256",
}).toString();
const authorizationUrl = url.toString();
const nativeUrl = new URL(authorizationUrl);
nativeUrl.searchParams.set("state", `otter_mail_${state}`);
const nativeAuthorizationUrl = nativeUrl.toString();
const callback = `${redirectUri}/?state=${state}&code=test-code`;

function harness() {
  const controller = new AbortController();
  const dispose = vi.fn();
  const error = vi.fn();
  const openBrowser = vi.fn(async () => {});
  let input!: MailGoogleAuthPrompt;
  return {
    controller,
    dispose,
    error,
    openBrowser,
    get input() {
      return input;
    },
    options: {
      authorizationUrl,
      signal: controller.signal,
      openBrowser,
      prompt: (value: MailGoogleAuthPrompt) => {
        input = value;
        return { dispose, error };
      },
    },
  };
}

describe("Mail's client Google sign-in", () => {
  it("uses the desktop callback capture and cleans it up after completion", async () => {
    const h = harness();
    const receiveNative = vi.fn(async () => callback.replace(state, `otter_mail_${state}`));
    const cancelNative = vi.fn(async () => {});
    expect(await receiveMailGoogleAuth({ ...h.options, receiveNative, cancelNative })).toBe(
      callback,
    );
    expect(receiveNative).toHaveBeenCalledWith(nativeAuthorizationUrl);
    expect(h.openBrowser).not.toHaveBeenCalled();
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(cancelNative).toHaveBeenCalledWith(nativeAuthorizationUrl);
  });

  it("allows web clients to retry an invalid callback and paste an address without its scheme", async () => {
    const h = harness();
    const pending = receiveMailGoogleAuth(h.options);
    expect(h.openBrowser).toHaveBeenCalledWith(authorizationUrl);
    h.input.submit(callback.replace(state, "x".repeat(22)));
    expect(h.error).toHaveBeenCalledOnce();
    expect(h.dispose).not.toHaveBeenCalled();
    h.input.submit(`  ${callback.slice("http://".length)}  `);
    expect(await pending).toBe(callback);
  });

  it("opens the normal sign-in link when the native loopback port is already occupied", async () => {
    const h = harness();
    const opened = deferred<void>();
    h.openBrowser.mockImplementation(async () => opened.resolve());
    const pending = receiveMailGoogleAuth({
      ...h.options,
      receiveNative: async () => {
        throw new Error("port is in use");
      },
    });
    await opened.promise;
    h.input.submit(callback);
    expect(await pending).toBe(callback);
    expect(h.openBrowser).toHaveBeenCalledWith(authorizationUrl);
  });

  it.each(["callback", "rejection"])(
    "cancels the native listener and prompt on timeout, ignoring a late %s",
    async (late) => {
      const h = harness();
      const native = deferred<string>();
      const cancelNative = vi.fn(async () => {});
      const pending = receiveMailGoogleAuth({
        ...h.options,
        receiveNative: () => native.promise,
        cancelNative,
      });
      const failure = expect(pending).rejects.toThrow("cancelled");
      h.controller.abort();
      if (late === "callback") native.resolve(callback);
      else native.reject(new Error("Native sign-in cancelled"));
      await failure;
      expect(cancelNative).toHaveBeenCalledOnce();
      expect(h.dispose).toHaveBeenCalledOnce();
      expect(h.openBrowser).not.toHaveBeenCalled();
    },
  );
});
