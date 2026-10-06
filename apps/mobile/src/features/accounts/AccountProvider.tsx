import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
import { AuthRequest, makeRedirectUri, ResponseType } from "expo-auth-session";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { createAccountSession } from "@t3tools/client-runtime/accounts";
import { ACCOUNT_CLIENT_IDS, ACCOUNT_OAUTH_SCOPES } from "@t3tools/shared/otterAccounts";
import type { OtterAccountUser } from "@t3tools/contracts/accounts";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";

const sessionKey = "otter-account-session-v1";
type AccountContextValue = {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly user: OtterAccountUser | null;
  readonly error: string | null;
  readonly getToken: () => Promise<string | null>;
  readonly signIn: () => Promise<void>;
  readonly signOut: () => Promise<void>;
};
const AccountContext = createContext<AccountContextValue>({
  isLoaded: true,
  isSignedIn: false,
  userId: null,
  user: null,
  error: null,
  getToken: async () => null,
  signIn: async () => {},
  signOut: async () => {},
});

export function AccountProvider({ children }: { readonly children: ReactNode }) {
  const [manager] = useState(() => {
    const config = resolveCloudPublicConfig();
    if (!config.accounts.url || !config.relay.url)
      throw new Error("Otter Accounts is not configured.");
    return createAccountSession({
      accountsUrl: config.accounts.url,
      resource: config.relay.url,
      clientId: ACCOUNT_CLIENT_IDS.mobile,
      fetch: globalThis.fetch,
      storage: {
        read: () => SecureStore.getItemAsync(sessionKey),
        write: (value) =>
          value
            ? SecureStore.setItemAsync(sessionKey, value, {
                keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
              })
            : SecureStore.deleteItemAsync(sessionKey),
      },
    });
  });
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [actions] = useState(() => ({
    signIn: async () => {
      setError(null);
      try {
        const config = resolveCloudPublicConfig();
        const redirectUri = makeRedirectUri({
          native: `${Constants.expoConfig?.scheme ?? "ottercode"}://account/callback`,
        });
        const request = new AuthRequest({
          clientId: ACCOUNT_CLIENT_IDS.mobile,
          redirectUri,
          responseType: ResponseType.Code,
          scopes: [...ACCOUNT_OAUTH_SCOPES],
          usePKCE: true,
          extraParams: { resource: config.relay.url! },
        });
        const result = await request.promptAsync({
          authorizationEndpoint: `${config.accounts.url}/oauth2/authorize`,
        });
        if (result.type === "cancel" || result.type === "dismiss") return;
        if (
          result.type !== "success" ||
          !result.params.code ||
          !request.codeVerifier ||
          result.params.iss !== config.accounts.url
        )
          throw new Error("Sign-in could not be completed. Please try again.");
        await manager.signIn({
          code: result.params.code,
          verifier: request.codeVerifier,
          redirectUri,
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Sign-in could not be completed.");
      }
    },
    signOut: async () => {
      setError(null);
      try {
        await manager.signOut();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not finish signing out.");
      }
    },
  }));
  useEffect(() => {
    let active = true;
    const report = (cause: unknown) => {
      if (active)
        setError(cause instanceof Error ? cause.message : "Could not restore your Otter account.");
    };
    void manager
      .load()
      .then(() => manager.validate())
      .catch(report);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void manager.validate().catch(report);
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [manager]);
  const value = useMemo(
    () => ({
      isLoaded: snapshot.loaded,
      isSignedIn: snapshot.user !== null,
      userId: snapshot.user?.id ?? null,
      user: snapshot.user,
      error,
      getToken: manager.readToken,
      ...actions,
    }),
    [snapshot, error, manager, actions],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export const useAuth = () => useContext(AccountContext);
