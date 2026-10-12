import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { SUITE_DRIVE_METHODS } from "@t3tools/contracts/suite";
import { useAuth } from "../accounts/AccountProvider";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { connectionAtomRuntime } from "../connection/runtime";
import { isElectron } from "../env";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "../state/environments";
import { createSuiteAccountSession, isLocalSuiteTarget } from "./accountSession";
import { invokeMailAccount } from "./mail/mailHost";
import { useSuiteCapabilities, suiteHasModule } from "./useSuiteCapabilities";

const syncDrive = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "suite:account:drive",
  tag: SUITE_DRIVE_METHODS.syncAccount,
});
const noPermission = Atom.make(false);
const Context = createContext<{
  readonly available: boolean;
  readonly ensure: () => Promise<void>;
  readonly signOut: () => Promise<void>;
}>({ available: false, ensure: async () => {}, signOut: async () => {} });

export function SuiteAccountProvider({ children }: { readonly children: ReactNode }) {
  const { getToken, signIn, signOut, isLoaded, isSignedIn, userId } = useAuth();
  const environmentId = usePrimaryEnvironmentId();
  const baseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const capabilities = useSuiteCapabilities();
  const canSync = useAtomValue(
    environmentId === null ? noPermission : syncDrive.permissionAtom(environmentId),
  );
  const available =
    canSync &&
    isLocalSuiteTarget(isElectron, baseUrl) &&
    suiteHasModule(capabilities, "mail") &&
    suiteHasModule(capabilities, "drive");
  const owner = useRef<string | null | undefined>(undefined);
  const session = useMemo(() => {
    if (!available || environmentId === null) return null;
    const accountsUrl = resolveCloudPublicConfig().accountsUrl;
    if (!accountsUrl) return null;
    return createSuiteAccountSession({
      accountsUrl,
      fetch: window.fetch.bind(window),
      apply: async (token) => {
        // Clear all surfaces even if one service is unavailable at sign-out.
        const results = await Promise.allSettled([
          invokeMailAccount(environmentId, token),
          runAtomCommand(
            appAtomRegistry,
            syncDrive,
            { environmentId, input: { token } },
            { reportFailure: false },
          ).then((result) => {
            if (result._tag !== "Success")
              throw new Error("Drive could not reuse your Otter sign-in.");
          }),
          window.desktopBridge?.drive?.syncAccount(token) ?? Promise.resolve(),
        ]);
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      },
    });
  }, [available, environmentId]);
  const value = useMemo(
    () => ({
      available: session !== null,
      ensure: async () => {
        if (!session) return;
        let token = await getToken();
        if (!token) {
          await signIn();
          token = await getToken();
        }
        if (!token) throw new Error("Sign in to your Otter account to continue.");
        await session.ensure(token, userId);
      },
      signOut: async () => {
        const results = await Promise.allSettled([session?.clear(), signOut()]);
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      },
    }),
    [getToken, signIn, signOut, userId, session],
  );
  useEffect(() => {
    if (!session) return;
    return window.desktopBridge?.drive?.onSignOut(() => {
      void value.signOut().catch(() => undefined);
    });
  }, [session, value]);
  useEffect(() => {
    if (!session || !isLoaded) return;
    let active = true;
    const sync = async () => {
      if (owner.current !== userId) await session.clear();
      if (!active) return;
      owner.current = userId;
      if (!isSignedIn) return;
      const token = await getToken();
      if (active && token) await session.ensure(token, userId);
    };
    // User actions report errors; background recovery retries on the next foreground/refresh.
    void sync().catch(() => undefined);
    const timer = setInterval(() => void sync().catch(() => undefined), 60_000);
    const foreground = () => {
      if (document.visibilityState === "visible") void sync().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", foreground);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [getToken, isLoaded, isSignedIn, userId, session]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useSuiteAccount = () => useContext(Context);
