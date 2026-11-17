import { accountAuthorizationUrl, ACCOUNT_CLIENT_IDS } from "@t3tools/shared/otterAccounts";
import {
  connectLoopbackRedirectUri,
  type ConnectAuthorizeRequest,
} from "@t3tools/shared/connectAuth";
import { isHostedStaticApp } from "../hostedPairing";
import { hasCloudPublicConfig, resolveCloudPublicConfig } from "./publicConfig";

export function connectCliAuthRoutesEnabled() {
  return isHostedStaticApp() && hasCloudPublicConfig();
}

export function buildConnectCliAuthorizeUrl(request: ConnectAuthorizeRequest): string | null {
  const { accountsUrl, relayUrl } = resolveCloudPublicConfig();
  if (!accountsUrl || !relayUrl) return null;
  return accountAuthorizationUrl({
    accountsUrl,
    resource: relayUrl,
    clientId: ACCOUNT_CLIENT_IDS.cli,
    redirectUri: connectLoopbackRedirectUri(request.loopbackPort),
    state: request.state,
    challenge: request.challenge,
  });
}
