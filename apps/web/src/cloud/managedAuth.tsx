import { useAuth } from "../accounts/AccountProvider";
import {
  createCloudAccountService,
  createOtterAccountSource,
  ManagedRelay,
  type OtterAccountSource,
  setManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect, useState, type ReactNode } from "react";

import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export function deactivateManagedRelayAuthentication(): void {
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateManagedRelayAuthentication(
  accountId: string,
  readAccountToken: () => Promise<string | null>,
): void {
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readAccountToken,
  });
}

const managedRelayAccountService = createCloudAccountService<OtterAccountSource>({
  deactivate: deactivateManagedRelayAuthentication,
  detach: deactivateManagedRelayAuthentication,
  cleanUp: async () => {
    const results = await Promise.all([
      runAtomCommand(appAtomRegistry, environmentCatalog.removeRelayEnvironments, undefined, {
        reportFailure: false,
        reportDefect: false,
      }),
      settleAsyncResult(() =>
        runtime.runPromiseExit(
          ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
        ),
      ),
    ]);
    for (const result of results) {
      reportAtomCommandResult(result, { label: "cloud account cleanup" });
    }
  },
  activate: ({ source, accountId }) =>
    activateManagedRelayAuthentication(accountId, source.getToken),
});

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const [source] = useState(createOtterAccountSource);
  useEffect(() => managedRelayAccountService.attach(source), [source]);
  useEffect(() => {
    source.update({
      accountId: !isLoaded ? undefined : isSignedIn && userId ? userId : null,
      getToken,
    });
  }, [source, getToken, isLoaded, isSignedIn, userId]);
  return children;
}
