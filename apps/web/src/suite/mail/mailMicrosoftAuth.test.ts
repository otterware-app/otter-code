import { describe, expect, it, vi } from "vite-plus/test";
import { type MailGoogleAuthPrompt } from "./mailGoogleAuth";
import { receiveMailMicrosoftAuth } from "./mailMicrosoftAuth";

const redirectUri = "http://localhost:42813";
const state = "m".repeat(22);
const url = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
url.search = new URLSearchParams({
  client_id: "1234-test-client",
  redirect_uri: redirectUri,
  response_type: "code",
  response_mode: "query",
  state,
  code_challenge: "c".repeat(43),
  code_challenge_method: "S256",
}).toString();
const authorizationUrl = url.toString();
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

describe("Mail's client Microsoft sign-in", () => {
  it("keeps the prompt open for an invalid callback, then returns a validated localhost address", async () => {
    const h = harness();
    const pending = receiveMailMicrosoftAuth(h.options);
    expect(h.input.provider).toBe("Microsoft");
    expect(h.openBrowser).toHaveBeenCalledWith(authorizationUrl);
    h.input.submit(callback.replace(state, "x".repeat(22)));
    expect(h.error).toHaveBeenCalledOnce();
    expect(h.dispose).not.toHaveBeenCalled();
    h.input.submit(`  ${callback.slice("http://".length)}  `);
    expect(await pending).toBe(callback);
    expect(h.dispose).toHaveBeenCalledOnce();
  });

  it("lets the user follow the sign-in link when the browser cannot open automatically", async () => {
    const h = harness();
    h.openBrowser.mockRejectedValue(new Error("Browser unavailable"));
    const pending = receiveMailMicrosoftAuth(h.options);
    await Promise.resolve();
    expect(h.error).toHaveBeenCalledWith(expect.stringContaining("sign-in link"));
    h.input.submit(callback);
    expect(await pending).toBe(callback);
  });

  it("returns declined consent to Mail's original sign-in flow", async () => {
    const h = harness();
    const pending = receiveMailMicrosoftAuth(h.options);
    const declined = callback.replace("code=test-code", "error=access_denied");
    h.input.submit(declined);
    expect(await pending).toBe(declined);
  });

  it("closes an aborted prompt and ignores a late callback", async () => {
    const h = harness();
    const pending = receiveMailMicrosoftAuth(h.options);
    const failure = expect(pending).rejects.toThrow("cancelled");
    h.controller.abort();
    h.input.submit(callback);
    await failure;
    expect(h.dispose).toHaveBeenCalledOnce();
  });

  it("does not open a prompt when the flow already ended", async () => {
    const h = harness();
    h.controller.abort();
    await expect(receiveMailMicrosoftAuth(h.options)).rejects.toThrow("ended");
    expect(h.openBrowser).not.toHaveBeenCalled();
  });
});
