import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AuthSurfaceShell } from "../components/auth/AuthSurfaceShell";
import { Button } from "../components/ui/button";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { parseAccountCallback } from "../accounts/callback";
import { useAuth } from "../accounts/AccountProvider";

export const Route = createFileRoute("/account/callback")({ component: AccountCallback });
type Callback = {
  readonly origin: string;
  readonly code: string;
  readonly state: string;
  readonly issuer: string;
};
function returnAuthorization(request: Callback) {
  const destination = new URL("/account/callback", request.origin);
  // Fragments stay out of HTTP logs and referrers on the destination server.
  destination.hash = new URLSearchParams({
    code: request.code,
    state: request.state,
    iss: request.issuer,
  }).toString();
  window.location.replace(destination.href);
}
function AccountCallback() {
  const { isLoaded, completeSignIn } = useAuth();
  const [message, setMessage] = useState("Finishing sign-in…");
  const [pending, setPending] = useState<Callback | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (!isLoaded || started.current) return;
    started.current = true;
    const query = new URLSearchParams(window.location.hash.slice(1) || window.location.search);
    history.replaceState(null, "", window.location.pathname);
    void (async () => {
      const state = query.get("state");
      const code = query.get("code");
      const issuer = resolveCloudPublicConfig().accountsUrl;
      if (!state || !code || !issuer || window.top !== window.self || query.get("iss") !== issuer)
        throw new Error("This sign-in request has expired. Start again in Otter Code.");
      const { origin, trusted } = parseAccountCallback(state);
      if (origin === window.location.origin) {
        const returnTo = await completeSignIn(code, state);
        if (!returnTo)
          throw new Error("This sign-in request has expired. Start again in Otter Code.");
        window.location.replace(returnTo);
      } else {
        const request = { origin, state, code, issuer };
        if (trusted) returnAuthorization(request);
        else {
          setPending(request);
          setMessage("Allow this Otter Code server to use your account?");
        }
      }
    })().catch((cause: unknown) =>
      setMessage(cause instanceof Error ? cause.message : "Sign-in could not be completed."),
    );
  }, [isLoaded, completeSignIn]);
  return (
    <AuthSurfaceShell>
      <h1 className="text-xl font-semibold">Otter account</h1>
      <p className="mt-3 text-sm text-muted-foreground">{message}</p>
      {pending ? (
        <>
          <p className="mt-3 break-all font-mono text-sm">{pending.origin}</p>
          <p className="mt-3 text-sm text-muted-foreground">
            Continue only if you opened this server yourself. It will receive your account identity
            and access to your Code cloud connections.
          </p>
          <div className="mt-5 flex gap-3">
            <Button onClick={() => returnAuthorization(pending)}>Continue</Button>
            <Button variant="outline" onClick={() => window.location.replace("/")}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-5">
          <Button variant="outline" onClick={() => window.location.replace("/")}>
            Return to Otter Code
          </Button>
        </div>
      )}
    </AuthSurfaceShell>
  );
}
