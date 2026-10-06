import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createAccountSession } from "@t3tools/client-runtime/accounts";
import {
  ACCOUNT_CLIENT_IDS,
  OTTER_CODE_WEB_URL,
  accountAuthorizationUrl,
  createAccountAuthorization,
} from "@t3tools/shared/otterAccounts";
import type { OtterAccountUser } from "@t3tools/contracts/accounts";

import { consumeBrowserAuthorization, saveBrowserAuthorization } from "./browserAuthorization";
import { isElectron } from "../env";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";

const SESSION_KEY = "otter-account-session-v1";
const callbackUrl = `${OTTER_CODE_WEB_URL}/account/callback`;
type AccountContextValue = {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly user: OtterAccountUser | null;
  readonly error: string | null;
  readonly getToken: () => Promise<string | null>;
  readonly signIn: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly completeSignIn: (code: string, state: string) => Promise<string | null>;
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
  completeSignIn: async () => null,
});

export function AccountProvider({ children }: { readonly children: ReactNode }) {
  const [manager] = useState(() => {
    const config = resolveCloudPublicConfig();
    if (!config.accountsUrl || !config.relayUrl)
      throw new Error("Otter Accounts is not configured.");
    return createAccountSession({
      accountsUrl: config.accountsUrl,
      resource: config.relayUrl,
      clientId: isElectron ? ACCOUNT_CLIENT_IDS.desktop : ACCOUNT_CLIENT_IDS.web,
      fetch: window.fetch.bind(window),
      ...(!isElectron && navigator.locks
        ? {
            withStorageLock: <T,>(operation: () => Promise<T>) =>
              navigator.locks.request(SESSION_KEY, operation),
          }
        : {}),
      storage: isElectron
        ? {
            read: async () => {
              if (!window.desktopBridge?.getAccountSession)
                throw new Error("Update Otter Code to sign in.");
              return window.desktopBridge.getAccountSession();
            },
            write: async (value) => {
              if (!window.desktopBridge?.setAccountSession)
                throw new Error("Update Otter Code to sign in.");
              await window.desktopBridge.setAccountSession(value);
            },
          }
        : {
            read: async () => localStorage.getItem(SESSION_KEY),
            write: async (value) => {
              if (value) localStorage.setItem(SESSION_KEY, value);
              else localStorage.removeItem(SESSION_KEY);
            },
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
        const request = await createAccountAuthorization(crypto);
        if (isElectron) {
          if (!window.desktopBridge?.authorizeAccount)
            throw new Error("Update Otter Code to sign in.");
          const result = await window.desktopBridge.authorizeAccount({
            state: request.state,
            challenge: request.challenge,
          });
          await manager.signIn({ ...result, verifier: request.verifier });
        } else {
          const state = JSON.stringify({ nonce: request.state, origin: window.location.origin });
          saveBrowserAuthorization(sessionStorage, {
            state,
            verifier: request.verifier,
            expiresAt: Date.now() + 10 * 60_000,
            returnTo: window.location.pathname + window.location.search,
          });
          window.location.assign(
            accountAuthorizationUrl({
              accountsUrl: config.accountsUrl!,
              resource: config.relayUrl!,
              clientId: ACCOUNT_CLIENT_IDS.web,
              redirectUri: callbackUrl,
              challenge: request.challenge,
              state,
            }),
          );
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Sign-in could not be completed.");
      }
    },
    completeSignIn: async (code: string, state: string) => {
      const request = consumeBrowserAuthorization(sessionStorage, state, Date.now());
      if (!request) return null;
      await manager.signIn({ code, verifier: request.verifier, redirectUri: callbackUrl });
      return request.returnTo;
    },
    signOut: async () => {
      setError(null);
      try {
        await manager.signOut();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not finish signing out.");
      }
      if (!isElectron) window.location.assign(`${OTTER_CODE_WEB_URL}/account/sign-out`);
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
    const foreground = () => {
      if (document.visibilityState === "visible") void manager.validate().catch(report);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === SESSION_KEY) void manager.load().catch(report);
    };
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("storage", storage);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener("storage", storage);
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
