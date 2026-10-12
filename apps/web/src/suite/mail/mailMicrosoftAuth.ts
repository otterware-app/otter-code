import {
  mailMicrosoftAuthorizationRequest,
  mailMicrosoftCallbackUrl,
} from "@t3tools/shared/suite/mailMicrosoftAuth";
import type { MailGoogleAuthPrompt } from "./mailGoogleAuth";

/** A remote client can return Microsoft's localhost redirect to Mail's server listener. */
export function receiveMailMicrosoftAuth(options: {
  readonly authorizationUrl: string;
  readonly signal: AbortSignal;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly prompt: (input: MailGoogleAuthPrompt) => {
    dispose: () => void;
    error: (message: string) => void;
  };
}): Promise<string> {
  const flow = mailMicrosoftAuthorizationRequest(options.authorizationUrl);
  if (options.signal.aborted) return Promise.reject(new Error("Microsoft sign-in ended."));
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", abort);
      prompt.dispose();
      if (value === undefined) reject(new Error("Microsoft sign-in was cancelled."));
      else resolve(value);
    };
    const abort = () => finish();
    const prompt = options.prompt({
      provider: "Microsoft",
      authorizationUrl: flow.authorizationUrl,
      submit: (value) => {
        if (settled) return;
        const trimmed = value.trim();
        const normalized = trimmed.startsWith("localhost:") ? `http://${trimmed}` : trimmed;
        try {
          finish(mailMicrosoftCallbackUrl(normalized, flow.redirectUri, flow.state).toString());
        } catch {
          prompt.error("Paste the full address Microsoft sent you to for this sign-in.");
        }
      },
      cancel: abort,
    });
    options.signal.addEventListener("abort", abort, { once: true });
    void options.openBrowser(flow.authorizationUrl).catch(() => {
      if (!settled) prompt.error("Use the sign-in link to open Microsoft in your browser.");
    });
  });
}
