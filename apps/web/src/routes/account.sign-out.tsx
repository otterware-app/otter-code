import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { OTTER_ACCOUNTS_URL } from "@t3tools/shared/otterAccounts";
import { AuthSurfaceShell } from "../components/auth/AuthSurfaceShell";
import { Button } from "../components/ui/button";

export const Route = createFileRoute("/account/sign-out")({ component: AccountSignOut });
function AccountSignOut() {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    localStorage.removeItem("otter-account-session-v1");
    form.current?.requestSubmit();
  }, []);
  return (
    <AuthSurfaceShell>
      <h1 className="text-xl font-semibold">Signing out of Otter</h1>
      <form
        ref={form}
        method="post"
        action={`${new URL(OTTER_ACCOUNTS_URL).origin}/otter/sign-out`}
      >
        <input type="hidden" name="app" value="accounts" />
        <div className="mt-4">
          <Button type="submit">Continue signing out</Button>
        </div>
      </form>
    </AuthSurfaceShell>
  );
}
