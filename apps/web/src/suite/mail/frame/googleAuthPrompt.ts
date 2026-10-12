import type { MailGoogleAuthPrompt } from "../mailGoogleAuth";

/** Keep the callback-address fallback visible for remote browser sign-in. */
export function showGoogleAuthPrompt({
  authorizationUrl,
  submit,
  cancel,
  provider = "Google",
}: MailGoogleAuthPrompt) {
  const form = document.createElement("form");
  form.setAttribute("aria-label", `Complete ${provider} sign-in`);
  form.style.cssText =
    "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;display:grid;gap:10px;width:min(520px,calc(100% - 32px));padding:16px;border-radius:10px;font:14px/1.5 var(--font-sans,system-ui);background:var(--popover);color:var(--popover-foreground);border:1px solid var(--border);box-shadow:0 8px 24px rgb(0 0 0/.18)";
  const title = document.createElement("strong");
  title.textContent = `Finish ${provider} sign-in`;
  const instructions = document.createElement("p");
  instructions.style.margin = "0";
  instructions.textContent =
    "After signing in, if the browser lands on an address that won't load, copy that full address and paste it here.";
  const link = document.createElement("a");
  link.href = authorizationUrl;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = `Open ${provider} sign-in`;
  link.style.color = "var(--primary)";
  const label = document.createElement("label");
  label.textContent = "Callback URL";
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = provider === "Microsoft" ? "http://localhost:…" : "http://127.0.0.1:…";
  input.style.cssText =
    "display:block;box-sizing:border-box;width:100%;margin-top:4px;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--background);color:inherit;font:inherit";
  label.append(input);
  const error = document.createElement("span");
  error.setAttribute("role", "alert");
  const buttons = document.createElement("div");
  buttons.style.cssText = "display:flex;gap:8px";
  const complete = document.createElement("button");
  complete.type = "submit";
  complete.textContent = "Complete sign-in";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Cancel";
  for (const button of [complete, dismiss]) {
    button.style.cssText =
      "padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--background);color:inherit;font:inherit;cursor:pointer";
  }
  dismiss.addEventListener("click", cancel);
  buttons.append(complete, dismiss);
  form.append(title, instructions, link, label, error, buttons);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(input.value);
  });
  document.body.append(form);
  return {
    dispose: () => {
      input.value = "";
      form.remove();
    },
    error: (message: string) => {
      error.textContent = message;
    },
  };
}
