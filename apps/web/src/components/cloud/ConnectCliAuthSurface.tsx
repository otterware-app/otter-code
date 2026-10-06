import { readConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";
import { useEffect, useState } from "react";
import { buildConnectCliAuthorizeUrl } from "../../cloud/connectCliAuth";
import { AuthSurfaceShell } from "../auth/AuthSurfaceShell";
import { Button } from "../ui/button";

export function ConnectCliAuthorizeSurface() {
  const [request] = useState(() => readConnectAuthorizeRequest(new URL(window.location.href)));
  const destination = request ? buildConnectCliAuthorizeUrl(request) : null;
  useEffect(() => {
    if (destination) window.location.replace(destination);
  }, [destination]);
  return (
    <AuthSurfaceShell>
      <h1 className="text-2xl font-semibold">
        {destination ? "Connecting your terminal" : "This connect link is incomplete"}
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        {destination
          ? "Continue with your Otter account to authorize this machine."
          : "Run otter-code connect in your terminal and open the new link."}
      </p>
      {destination ? (
        <div className="mt-6">
          <Button onClick={() => window.location.assign(destination)}>Continue with Otter</Button>
        </div>
      ) : null}
    </AuthSurfaceShell>
  );
}
