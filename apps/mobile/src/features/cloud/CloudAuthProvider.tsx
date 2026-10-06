import { createOtterAccountSource } from "@t3tools/client-runtime/relay";
import { type ReactNode, useEffect, useState } from "react";

import { AccountProvider, useAuth } from "../accounts/AccountProvider";
import { cloudAccountService, deactivateCloudRelayAccount } from "./cloudAccountService";
import { hasCloudPublicConfig } from "./publicConfig";

// Build-time constant: false when this build has no cloud config.
const cloudEnabled = hasCloudPublicConfig();

if (!cloudEnabled) {
  // Without cloud config no account can ever activate, so drop anything a
  // previous build with cloud enabled left registered.
  deactivateCloudRelayAccount();
}

function CloudAuthBridge(props: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const [source] = useState(createOtterAccountSource);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches the account source to the cloud account service while mounted
  useEffect(() => cloudAccountService.attach(source), [source]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the Otter session into the account source the cloud service reads
  useEffect(() => {
    source.update({
      accountId: !isLoaded ? undefined : isSignedIn && userId ? userId : null,
      getToken,
    });
  }, [source, getToken, isLoaded, isSignedIn, userId]);
  return props.children;
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  if (!cloudEnabled) {
    return props.children;
  }

  return (
    <AccountProvider>
      <CloudAuthBridge>{props.children}</CloudAuthBridge>
    </AccountProvider>
  );
}
