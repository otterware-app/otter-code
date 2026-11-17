import { readConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";
import { useEffect, useState } from "react";
import { buildConnectCliAuthorizeUrl } from "../../cloud/connectCliAuth";
import { StandalonePage } from "../ui/standalone-page";
import { Button } from "../ui/button";

export function ConnectCliAuthorizeSurface() {
  const [request] = useState(() => readConnectAuthorizeRequest(new URL(window.location.href)));
  const destination = request ? buildConnectCliAuthorizeUrl(request) : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- navigates the window to the Otter authorize URL once the request is read
  useEffect(() => {
    if (destination) window.location.replace(destination);
  }, [destination]);
  return (
    <StandalonePage>
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
    </StandalonePage>
  );
}
