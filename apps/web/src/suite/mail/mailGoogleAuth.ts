import { googleCallbackUrl } from "@t3tools/shared/googleAuthCallback";
import { mailGoogleAuthorizationRequest } from "@t3tools/shared/suite/mailGoogleAuth";

export interface MailGoogleAuthPrompt {
  readonly authorizationUrl: string;
  readonly submit: (callbackUrl: string) => void;
  readonly cancel: () => void;
}

/** Desktop captures the redirect automatically; every client can paste it when needed. */
export function receiveMailGoogleAuth(options: {
  readonly authorizationUrl: string;
  readonly signal: AbortSignal;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly receiveNative?: ((url: string) => Promise<string>) | undefined;
  readonly cancelNative?: ((url: string) => Promise<void>) | undefined;
  readonly prompt: (input: MailGoogleAuthPrompt) => {
    dispose: () => void;
    error: (message: string) => void;
  };
}): Promise<string> {
  const flow = mailGoogleAuthorizationRequest(options.authorizationUrl);
  if (options.signal.aborted) return Promise.reject(new Error("Google sign-in ended."));
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      options.signal.removeEventListener("abort", abort);
      prompt.dispose();
      if (options.receiveNative)
        void options.cancelNative?.(flow.nativeAuthorizationUrl).catch(() => {});
    };
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (value === undefined) reject(new Error("Google sign-in was cancelled."));
      else resolve(value);
    };
    const submit = (value: string) => {
      if (settled) return;
      const trimmed = value.trim();
      const normalized = trimmed.startsWith("127.0.0.1:") ? `http://${trimmed}` : trimmed;
      try {
        finish(googleCallbackUrl(normalized, flow.redirectUri, flow.state).toString());
      } catch {
        prompt.error("Paste the full address Google sent you to for this sign-in.");
      }
    };
    const abort = () => finish();
    const prompt = options.prompt({
      authorizationUrl: flow.authorizationUrl,
      submit,
      cancel: abort,
    });
    options.signal.addEventListener("abort", abort, { once: true });
    const openManually = async () => {
      if (settled) return;
      try {
        await options.openBrowser(flow.authorizationUrl);
      } catch {
        if (!settled) prompt.error("Use the sign-in link to open Google in your browser.");
      }
    };
    if (options.receiveNative) {
      // The native helper binds before opening Google. A local server may already own the
      // port; opening the link normally then lets that server receive the redirect itself.
      void options.receiveNative(flow.nativeAuthorizationUrl).then(
        (value) => {
          if (settled) return;
          try {
            const callback = googleCallbackUrl(value, flow.redirectUri, flow.nativeState);
            callback.searchParams.set("state", flow.state);
            submit(callback.toString());
          } catch {
            void openManually();
          }
        },
        () => openManually(),
      );
    } else void openManually();
  });
}
